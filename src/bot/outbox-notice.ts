import { interruptionNoticeCard } from '../card/templates';
import { log } from '../core/logger';
import { withDeliveryUuid } from './feishu-delivery';
import {
  noticeDeliveryKey,
  noticeOwnerDeliveryKey,
  type TurnJournal,
  type TurnJournalEntry,
  type TurnNotice,
} from './turn-journal';
import {
  buildAuthInitiatorMarkdown,
  buildAuthOwnerMarkdown,
  buildNoticeMarkdown,
  noticeUsesButtons,
  planInterruptionNotice,
  NOTICE_TTL_MS,
  type NoticeActionAuth,
  type NoticeSender,
} from './interruption-notice';
import type { RunOutcome } from './run-outcome';

export function authNoticeAlreadyDelivered(journal: TurnJournal): boolean {
  return journal
    .list()
    .some(
      (entry) =>
        entry.notice?.kind === 'auth' &&
        (entry.status === 'notice-delivered' ||
          entry.notice.initiatorDelivered),
    );
}

export async function deliverInterruptionNotice(input: {
  send: NoticeSender;
  journal: TurnJournal;
  turnId: string;
  outcome: RunOutcome;
  noticeAuth?: NoticeActionAuth;
  consecutive: number;
  requireBotMention: boolean;
  ownerId?: string;
  authNotified: boolean;
}): Promise<{ delivered: boolean; pending: boolean }> {
  const entry = stageInterruptionNotice(input);
  if (!entry) return { delivered: false, pending: false };
  const plan = planInterruptionNotice(input.outcome);
  if (plan.kind === 'auth') return sendAuthNotice(input, entry);
  return sendContinueNotice(input, entry);
}

export function stageInterruptionNotice(input: {
  journal: TurnJournal;
  turnId: string;
  outcome: RunOutcome;
  noticeAuth?: NoticeActionAuth;
  consecutive: number;
  requireBotMention: boolean;
  ownerId?: string;
  authNotified: boolean;
}): TurnJournalEntry | undefined {
  const entry = input.journal.get(input.turnId);
  if (!entry) return undefined;
  const plan = planInterruptionNotice(input.outcome);
  if (plan.kind === 'none') return undefined;
  if (plan.kind === 'auth') {
    if (input.authNotified || authNoticeAlreadyDelivered(input.journal))
      return undefined;
    return stageAuthNotice(input, entry);
  }
  return stageContinueNotice(input, entry);
}

export async function resendPendingNotice(input: {
  send: NoticeSender;
  entry: TurnJournalEntry;
  journal?: TurnJournal;
  noticeAuth?: NoticeActionAuth;
}): Promise<boolean> {
  const notice = input.entry.notice;
  if (!notice || input.entry.noticeInvalidated) return false;
  if (notice.messageId) return true;
  return sendExistingNotice(input, notice);
}

async function sendExistingNotice(
  input: {
    send: NoticeSender;
    entry: TurnJournalEntry;
    journal?: TurnJournal;
    noticeAuth?: NoticeActionAuth;
  },
  notice: TurnNotice,
): Promise<boolean> {
  if (notice.kind === 'auth') {
    return sendAuthPayload(input.send, input.entry, notice, input.journal);
  }
  await postNotice(
    input.send,
    input.entry,
    notice,
    input.noticeAuth,
    input.journal,
  );
  return true;
}

function stageContinueNotice(
  input: {
    journal: TurnJournal;
    turnId: string;
    outcome: RunOutcome;
    noticeAuth?: NoticeActionAuth;
    consecutive: number;
    requireBotMention: boolean;
  },
  entry: TurnJournalEntry,
): TurnJournalEntry {
  const existing = entry.status === 'notice-pending' ? entry.notice : undefined;
  const buttons =
    noticeUsesButtons(input.consecutive) && Boolean(input.noticeAuth);
  let notice: TurnNotice = existing ?? {
    kind: buttons ? 'continue' : 'plain',
    recipientChatId: entry.chatId,
    markdown: buildNoticeMarkdown({
      initiatorId: entry.initiatorId || entry.senderId,
      requireBotMention: input.requireBotMention,
      outcome: input.outcome,
      includeButtons: buttons,
      mentionInitiator: entry.initiatorType !== 'bot',
    }),
    replyTo: entry.messageIds.at(-1),
    ...(entry.threadId ? { replyInThread: true } : {}),
    includeButtons: buttons,
    deliveryId: noticeDeliveryKey(input.turnId),
  };
  if (!notice.deliveryId)
    notice = { ...notice, deliveryId: noticeDeliveryKey(input.turnId) };
  if (!existing) {
    input.journal.markInterrupted(
      input.turnId,
      input.outcome,
      input.consecutive,
    );
    input.journal.stageNotice(input.turnId, notice);
  } else if (!existing.deliveryId) {
    input.journal.stageNotice(input.turnId, notice);
  }
  return input.journal.get(input.turnId) ?? { ...entry, notice };
}

async function sendContinueNotice(
  input: {
    send: NoticeSender;
    journal: TurnJournal;
    turnId: string;
    outcome: RunOutcome;
    noticeAuth?: NoticeActionAuth;
    consecutive: number;
    requireBotMention: boolean;
  },
  entry: TurnJournalEntry,
): Promise<{ delivered: boolean; pending: boolean }> {
  const staged = stageContinueNotice(input, entry);
  const notice = staged.notice;
  if (!notice) return { delivered: false, pending: false };
  if (notice.messageId) {
    input.journal.noticeDelivered(input.turnId);
    return { delivered: true, pending: false };
  }
  try {
    await postNotice(
      input.send,
      { ...staged, notice },
      notice,
      input.noticeAuth,
      input.journal,
    );
    input.journal.noticeDelivered(input.turnId);
    log.info('notice', 'sent', {
      turnId: input.turnId,
      kind: notice.kind,
      consecutive: input.consecutive,
    });
    return { delivered: true, pending: false };
  } catch (error) {
    log.warn('notice', 'send-failed', {
      turnId: input.turnId,
      err: error instanceof Error ? error.message : String(error),
    });
    return { delivered: false, pending: true };
  }
}

function stageAuthNotice(
  input: {
    journal: TurnJournal;
    turnId: string;
    ownerId?: string;
  },
  entry: TurnJournalEntry,
): TurnJournalEntry {
  const existing = entry.status === 'notice-pending' ? entry.notice : undefined;
  const notice: TurnNotice = existing ?? {
    kind: 'auth',
    recipientChatId: entry.chatId,
    markdown: buildAuthInitiatorMarkdown(
      entry.initiatorId || entry.senderId,
      entry.initiatorType !== 'bot',
    ),
    replyTo: entry.messageIds.at(-1),
    ...(entry.threadId ? { replyInThread: true } : {}),
    ...(input.ownerId ? { ownerChatId: input.ownerId } : {}),
    deliveryId: noticeDeliveryKey(input.turnId),
  };
  if (!existing) input.journal.stageNotice(input.turnId, notice);
  return input.journal.get(input.turnId) ?? { ...entry, notice };
}

async function sendAuthNotice(
  input: {
    send: NoticeSender;
    journal: TurnJournal;
    turnId: string;
    ownerId?: string;
  },
  entry: TurnJournalEntry,
): Promise<{ delivered: boolean; pending: boolean }> {
  const staged = stageAuthNotice(input, entry);
  const notice = staged.notice;
  if (!notice) return { delivered: false, pending: false };
  if (
    notice.messageId ||
    (notice.initiatorDelivered &&
      (!notice.ownerChatId || notice.ownerDelivered))
  ) {
    input.journal.noticeDelivered(input.turnId);
    return { delivered: true, pending: false };
  }
  try {
    const ok = await sendAuthPayload(
      input.send,
      { ...staged, notice },
      notice,
      input.journal,
    );
    if (ok) {
      input.journal.noticeDelivered(input.turnId);
      log.info('notice', 'sent', { turnId: input.turnId, kind: 'auth' });
      return { delivered: true, pending: false };
    }
    return { delivered: false, pending: true };
  } catch (error) {
    log.warn('notice', 'send-failed', {
      turnId: input.turnId,
      err: error instanceof Error ? error.message : String(error),
    });
    return { delivered: false, pending: true };
  }
}

async function sendAuthPayload(
  send: NoticeSender,
  entry: TurnJournalEntry,
  notice: TurnNotice,
  journal?: TurnJournal,
): Promise<boolean> {
  const next: TurnNotice = { ...notice };
  try {
    if (!next.initiatorDelivered) {
      const result = await send(
        next.recipientChatId,
        { markdown: next.markdown },
        sendOpts(entry, next),
      );
      requireReceipt(result, 'auth-initiator');
      next.initiatorDelivered = true;
      journal?.recordNotice(entry.turnId, next);
    }
    if (next.ownerChatId && !next.ownerDelivered) {
      const result = await send(
        next.ownerChatId,
        { markdown: buildAuthOwnerMarkdown() },
        withDeliveryUuid({}, noticeOwnerDeliveryKey(entry.turnId)),
      );
      requireReceipt(result, 'auth-owner');
      next.ownerDelivered = true;
      journal?.recordNotice(entry.turnId, next);
    }
    return Boolean(
      next.initiatorDelivered && (!next.ownerChatId || next.ownerDelivered),
    );
  } catch (error) {
    journal?.recordNotice(entry.turnId, next);
    throw error;
  }
}

async function postNotice(
  send: NoticeSender,
  entry: TurnJournalEntry,
  notice: TurnNotice,
  noticeAuth?: NoticeActionAuth,
  journal?: TurnJournal,
): Promise<void> {
  const opts = sendOpts(entry, notice);
  if (notice.includeButtons && noticeAuth && entry.policyFingerprint) {
    const continueToken = noticeAuth.sign({
      turnId: entry.turnId,
      scope: entry.scope,
      chatId: entry.chatId,
      action: 'notice.continue',
      policyFingerprint: entry.policyFingerprint,
      ttlMs: NOTICE_TTL_MS,
    });
    const dismissToken = noticeAuth.sign({
      turnId: entry.turnId,
      scope: entry.scope,
      chatId: entry.chatId,
      action: 'notice.dismiss',
      policyFingerprint: entry.policyFingerprint,
      ttlMs: NOTICE_TTL_MS,
    });
    const result = await send(
      notice.recipientChatId,
      {
        card: interruptionNoticeCard({
          body: notice.markdown,
          continueToken,
          dismissToken,
        }),
      },
      opts,
    );
    requireReceipt(result, 'notice-card');
    persistNoticeMessageId(journal, entry.turnId, notice, result.messageId);
    return;
  }
  const result = await send(
    notice.recipientChatId,
    { markdown: notice.markdown },
    opts,
  );
  requireReceipt(result, 'notice-text');
  persistNoticeMessageId(journal, entry.turnId, notice, result.messageId);
}

function persistNoticeMessageId(
  journal: TurnJournal | undefined,
  turnId: string,
  notice: TurnNotice,
  messageId: string | undefined,
): void {
  if (!journal || !messageId?.trim()) return;
  const current = journal.get(turnId)?.notice ?? notice;
  journal.recordNotice(turnId, { ...current, messageId });
  journal.noteNonAnswerId(turnId, messageId);
}

function sendOpts(
  entry: TurnJournalEntry,
  notice: TurnNotice,
): { replyTo?: string; replyInThread?: boolean; uuid?: string } {
  const replyTo = notice.replyTo ?? entry.messageIds.at(-1);
  return withDeliveryUuid(
    {
      ...(replyTo ? { replyTo } : {}),
      ...(notice.replyInThread || entry.threadId
        ? { replyInThread: true }
        : {}),
    },
    notice.deliveryId ?? noticeDeliveryKey(entry.turnId),
  );
}

function requireReceipt(result: { messageId?: string }, type: string): void {
  if (!result.messageId?.trim())
    throw new Error(`${type} notice missing message receipt`);
}
