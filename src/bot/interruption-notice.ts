import { ActionTokenCodec, type ActionTokenInvalidReason, type ActionTokenPurpose } from '../card/action-token';
import type { CallbackNonceStore } from '../card/callback-store';
import { interruptionNoticeCard } from '../card/templates';
import { log } from '../core/logger';
import { describeRunOutcome, type RunOutcome } from './run-outcome';
import { withDeliveryUuid } from './feishu-delivery';
import {
  noticeDeliveryKey,
  noticeOwnerDeliveryKey,
  type TurnJournal,
  type TurnJournalEntry,
  type TurnNotice,
} from './turn-journal';

export const CONTINUE_HINT =
  '上一轮在哪里、因为什么被中断，请先核对已完成的步骤，避免重复执行有副作用的操作';
export const ABANDON_HINT =
  '现已放弃。不得继续或重做上一轮未完成的工作，只处理用户现在这条新消息';
export const NOTICE_MAX_BUTTON_STREAK = 3;
export const NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
export const NOTICE_RESTART_GAP_MS = 500;

export type NoticeKind = 'none' | 'continue' | 'auth';
export type NoticeAction = 'notice.continue' | 'notice.dismiss';
export type NoticeResolution = 'continued' | 'dismissed' | 'abandoned';
export type NoticeCardUpdater = (messageId: string, card: object) => Promise<void>;

export interface NoticePlan {
  kind: NoticeKind;
}

export function planInterruptionNotice(outcome: RunOutcome): NoticePlan {
  switch (outcome.kind) {
    case 'completed':
      return { kind: 'none' };
    case 'partial':
      return outcome.retriable ? { kind: 'continue' } : { kind: 'none' };
    case 'interrupted':
      if (
        outcome.reason.type === 'user-stop'
        || outcome.reason.type === 'superseded'
        || outcome.reason.type === 'policy-guard'
      ) {
        return { kind: 'none' };
      }
      return { kind: 'continue' };
    case 'failed':
      if (outcome.cause === 'auth-required') return { kind: 'auth' };
      return outcome.retriable ? { kind: 'continue' } : { kind: 'none' };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export function noticeUsesButtons(consecutive: number): boolean {
  return consecutive <= NOTICE_MAX_BUTTON_STREAK;
}

export function isContinuePrompt(content: string): boolean {
  const stripped = content
    .replace(/@_user_\d+/g, ' ')
    .replace(/<at\b[^>]*>\s*<\/at>/gi, ' ')
    .replace(/@bot/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(继续|continue)$/i.test(stripped);
}

export function buildNoticeMarkdown(input: {
  initiatorId: string;
  requireBotMention: boolean;
  outcome: RunOutcome;
  includeButtons?: boolean;
  mentionInitiator?: boolean;
}): string {
  const mention = input.mentionInitiator === false ? '' : `<at id="${input.initiatorId}"></at> `;
  const reason = describeRunOutcome(input.outcome);
  const buttons = input.includeButtons !== false;
  const continuePhrase = input.requireBotMention ? '@bot 继续' : '继续';
  const actionLine = buttons
    ? `点「继续 / 暂不」，或 ${continuePhrase}。`
    : `或 ${continuePhrase}。`;
  return `${mention}上一轮未完成（${reason}）。${CONTINUE_HINT}。${actionLine}`;
}

export function buildAuthInitiatorMarkdown(initiatorId: string, mentionInitiator = true): string {
  const mention = mentionInitiator ? `<at id="${initiatorId}"></at> ` : '';
  return `${mention}CLI 登录已失效，需要重新登录后再试。这次不能继续，新的消息仍会照常处理。`;
}

export function buildAuthOwnerMarkdown(): string {
  return '有一次 run 因为 CLI 登录失效而停下。请重新登录对应 CLI；新的消息不会被暂停。';
}

export function continueExtraInstruction(outcome: RunOutcome, userInput?: string): string {
  const base = `上一轮因为「${describeRunOutcome(outcome)}」被中断。${CONTINUE_HINT}。`;
  const trimmed = userInput?.trim();
  if (!trimmed) return base;
  return `${base}\n原始输入：\n${trimmed}`;
}

export function abandonExtraInstruction(outcome: RunOutcome): string {
  return `上一轮因为「${describeRunOutcome(outcome)}」被中断，${ABANDON_HINT}。`;
}

export interface NoticeSignInput {
  turnId: string;
  scope: string;
  chatId: string;
  action: NoticeAction;
  policyFingerprint: string;
  ttlMs: number;
}

export interface NoticePayload {
  turnId: string;
  scope: string;
  chatId: string;
  action: NoticeAction;
  policyFingerprint: string;
  exp: number;
  nonce: string;
}

type NoticeClaims = Omit<NoticeSignInput, 'ttlMs'>;

export type NoticeVerifyResult =
  | { ok: true; payload: NoticePayload }
  | { ok: false; reason: ActionTokenInvalidReason };

export const noticeActionPurpose: ActionTokenPurpose<NoticeClaims> = {
  prefix: 'notice_cb.v2',
  noncePolicy: 'consume-on-verify',
  parseClaims(value) {
    const raw = value as Partial<NoticeClaims> | null;
    if (!raw || typeof raw.turnId !== 'string' || typeof raw.scope !== 'string'
      || typeof raw.chatId !== 'string' || typeof raw.policyFingerprint !== 'string'
      || (raw.action !== 'notice.continue' && raw.action !== 'notice.dismiss')) return undefined;
    return { turnId: raw.turnId, scope: raw.scope, chatId: raw.chatId,
      action: raw.action, policyFingerprint: raw.policyFingerprint };
  },
};

export class NoticeActionAuth {
  private readonly codec: ActionTokenCodec;

  constructor(options: ActionTokenCodec | {
    secret: string;
    nonceStore: CallbackNonceStore;
    now?: () => number;
    createNonce?: () => string;
  }) {
    this.codec = options instanceof ActionTokenCodec ? options : new ActionTokenCodec({
      ...options, keys: [{ version: 1, secret: options.secret }],
    });
  }

  sign({ ttlMs, ...claims }: NoticeSignInput): string {
    return this.codec.sign(noticeActionPurpose, claims, ttlMs);
  }

  verify(token: string, context: Partial<NoticeClaims> = {}): NoticeVerifyResult {
    const result = this.codec.verify(token, noticeActionPurpose, context);
    if (!result.ok) return result;
    return { ok: true, payload: { ...result.claims, exp: result.exp, nonce: result.nonce! } };
  }
}

export type NoticeSender = (
  chatId: string,
  content: { markdown: string } | { card: object },
  options?: { replyTo?: string; replyInThread?: boolean; uuid?: string },
) => Promise<{ messageId?: string }>;

export function resolvedNoticeCard(resolution: NoticeResolution): object {
  switch (resolution) {
    case 'continued':
      return interruptionNoticeCard({ body: '已继续' });
    case 'dismissed':
      return interruptionNoticeCard({ body: '已忽略' });
    case 'abandoned':
      return interruptionNoticeCard({ body: '已放弃' });
    default: {
      const _exhaustive: never = resolution;
      return _exhaustive;
    }
  }
}

export async function resolveInterruptionNotice(input: {
  journal: TurnJournal;
  turnId: string;
  resolution: NoticeResolution;
  updateCard?: NoticeCardUpdater;
}): Promise<void> {
  const notice = input.journal.get(input.turnId)?.notice;
  if (!notice?.includeButtons || !notice.messageId || !input.updateCard) return;
  try {
    await input.updateCard(notice.messageId, resolvedNoticeCard(input.resolution));
    log.info('notice', 'resolved', { turnId: input.turnId, resolution: input.resolution });
  } catch (error) {
    log.warn('notice', 'resolve-failed', {
      turnId: input.turnId,
      resolution: input.resolution,
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

export function authNoticeAlreadyDelivered(journal: TurnJournal): boolean {
  return journal.list().some((entry) => (
    entry.notice?.kind === 'auth' && (entry.status === 'notice-delivered' || entry.notice.initiatorDelivered)
  ));
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
    if (input.authNotified || authNoticeAlreadyDelivered(input.journal)) return undefined;
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
  await postNotice(input.send, input.entry, notice, input.noticeAuth, input.journal);
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
  const buttons = noticeUsesButtons(input.consecutive) && Boolean(input.noticeAuth);
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
  if (!notice.deliveryId) notice = { ...notice, deliveryId: noticeDeliveryKey(input.turnId) };
  if (!existing) {
    input.journal.markInterrupted(input.turnId, input.outcome, input.consecutive);
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
    await postNotice(input.send, { ...staged, notice }, notice, input.noticeAuth, input.journal);
    input.journal.noticeDelivered(input.turnId);
    log.info('notice', 'sent', { turnId: input.turnId, kind: notice.kind, consecutive: input.consecutive });
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
  if (notice.messageId || (notice.initiatorDelivered && (!notice.ownerChatId || notice.ownerDelivered))) {
    input.journal.noticeDelivered(input.turnId);
    return { delivered: true, pending: false };
  }
  try {
    const ok = await sendAuthPayload(input.send, { ...staged, notice }, notice, input.journal);
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
    return Boolean(next.initiatorDelivered && (!next.ownerChatId || next.ownerDelivered));
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
      { card: interruptionNoticeCard({ body: notice.markdown, continueToken, dismissToken }) },
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
  return withDeliveryUuid({
    ...(replyTo ? { replyTo } : {}),
    ...(notice.replyInThread || entry.threadId ? { replyInThread: true } : {}),
  }, notice.deliveryId ?? noticeDeliveryKey(entry.turnId));
}

function requireReceipt(result: { messageId?: string }, type: string): void {
  if (!result.messageId?.trim()) throw new Error(`${type} notice missing message receipt`);
}
