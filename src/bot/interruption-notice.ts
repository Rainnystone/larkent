import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CallbackNonceStore } from '../card/callback-store';
import { interruptionNoticeCard } from '../card/templates';
import { log } from '../core/logger';
import { describeRunOutcome, type RunOutcome } from './run-outcome';
import {
  noticeDeliveryKey,
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

const liveNoticeSends = new Set<string>();

export function isLiveNoticeSend(turnId: string): boolean {
  return liveNoticeSends.has(turnId);
}

function beginLiveNoticeSend(turnId: string): void {
  liveNoticeSends.add(turnId);
}

export function endLiveNoticeSend(turnId: string): void {
  liveNoticeSends.delete(turnId);
}

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
      if (outcome.reason.type === 'user-stop' || outcome.reason.type === 'superseded') {
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
}): string {
  const mention = `<at id="${input.initiatorId}"></at>`;
  const reason = describeRunOutcome(input.outcome);
  const buttons = input.includeButtons !== false;
  const continuePhrase = input.requireBotMention ? '@bot 继续' : '继续';
  const actionLine = buttons
    ? `点「继续 / 暂不」，或 ${continuePhrase}。`
    : `或 ${continuePhrase}。`;
  return `${mention} 上一轮未完成（${reason}）。${CONTINUE_HINT}。${actionLine}`;
}

export function buildAuthInitiatorMarkdown(initiatorId: string): string {
  return `<at id="${initiatorId}"></at> CLI 登录已失效，需要重新登录后再试。这次不能继续，新的消息仍会照常处理。`;
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

export type NoticeVerifyResult =
  | { ok: true; payload: NoticePayload }
  | {
      ok: false;
      reason: 'malformed' | 'bad-signature' | 'expired' | 'nonce-replay' | 'nonce-revoked';
    };

const PREFIX = 'notice_cb.v1';

export class NoticeActionAuth {
  private readonly secret: string;
  private readonly nonceStore: CallbackNonceStore;
  private readonly now: () => number;
  private readonly createNonce: () => string;

  constructor(options: {
    secret: string;
    nonceStore: CallbackNonceStore;
    now?: () => number;
    createNonce?: () => string;
  }) {
    this.secret = options.secret;
    this.nonceStore = options.nonceStore;
    this.now = options.now ?? Date.now;
    this.createNonce = options.createNonce ?? (() => randomBytes(16).toString('base64url'));
  }

  sign(input: NoticeSignInput): string {
    const payload = {
      t: input.turnId,
      s: input.scope,
      c: input.chatId,
      a: input.action,
      fp: input.policyFingerprint,
      exp: this.now() + input.ttlMs,
      n: this.createNonce(),
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${PREFIX}.${encoded}.${sign(encoded, this.secret)}`;
  }

  verify(token: string): NoticeVerifyResult {
    const parts = token.split('.');
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== PREFIX) {
      return { ok: false, reason: 'malformed' };
    }
    const encoded = parts[2];
    const signature = parts[3];
    if (!encoded || !signature) return { ok: false, reason: 'malformed' };
    if (!signatureMatches(signature, sign(encoded, this.secret))) {
      return { ok: false, reason: 'bad-signature' };
    }
    const payload = decodePayload(encoded);
    if (!payload) return { ok: false, reason: 'malformed' };
    if (payload.exp <= this.now()) return { ok: false, reason: 'expired' };
    const nonceState = this.nonceStore.state(payload.nonce);
    if (nonceState === 'revoked') return { ok: false, reason: 'nonce-revoked' };
    if (nonceState === 'used') return { ok: false, reason: 'nonce-replay' };
    if (!this.nonceStore.consume(payload.nonce)) return { ok: false, reason: 'nonce-replay' };
    return { ok: true, payload };
  }
}

function decodePayload(encoded: string): NoticePayload | undefined {
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof raw.t !== 'string'
      || typeof raw.s !== 'string'
      || typeof raw.c !== 'string'
      || (raw.a !== 'notice.continue' && raw.a !== 'notice.dismiss')
      || typeof raw.fp !== 'string'
      || typeof raw.exp !== 'number'
      || typeof raw.n !== 'string'
    ) {
      return undefined;
    }
    return {
      turnId: raw.t,
      scope: raw.s,
      chatId: raw.c,
      action: raw.a,
      policyFingerprint: raw.fp,
      exp: raw.exp,
      nonce: raw.n,
    };
  } catch {
    return undefined;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signatureMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export type NoticeSender = (
  chatId: string,
  content: { markdown: string } | { card: object },
  options?: { replyTo?: string; replyInThread?: boolean },
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
  stageOnly?: boolean;
}): Promise<{ delivered: boolean; pending: boolean }> {
  const entry = input.journal.get(input.turnId);
  if (!entry) return { delivered: false, pending: false };
  const plan = planInterruptionNotice(input.outcome);
  if (plan.kind === 'none') return { delivered: false, pending: false };
  if (plan.kind === 'auth') {
    if (input.authNotified || authNoticeAlreadyDelivered(input.journal)) {
      return { delivered: false, pending: false };
    }
    return sendAuthNotice(input, entry);
  }
  return sendContinueNotice(input, entry);
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
  if (
    isLiveNoticeSend(input.entry.turnId)
    || input.journal?.isDelivering(noticeDeliveryKey(input.entry.turnId))
  ) {
    return false;
  }
  const key = noticeDeliveryKey(input.entry.turnId);
  const sent = await (input.journal
    ? input.journal.withDelivery(key, () => sendExistingNotice(input, notice))
    : sendExistingNotice(input, notice));
  return sent === true;
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

async function sendContinueNotice(
  input: {
    send: NoticeSender;
    journal: TurnJournal;
    turnId: string;
    outcome: RunOutcome;
    noticeAuth?: NoticeActionAuth;
    consecutive: number;
    requireBotMention: boolean;
    stageOnly?: boolean;
  },
  entry: TurnJournalEntry,
): Promise<{ delivered: boolean; pending: boolean }> {
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
    }),
    replyTo: entry.messageIds.at(-1),
    ...(entry.threadId ? { replyInThread: true } : {}),
    includeButtons: buttons,
    deliveryId: randomUUID(),
  };
  if (!notice.deliveryId) notice = { ...notice, deliveryId: randomUUID() };
  if (!existing) {
    input.journal.markInterrupted(input.turnId, input.outcome, input.consecutive);
    input.journal.markNoticePending(input.turnId, notice);
  } else if (!existing.deliveryId) {
    input.journal.markNoticePending(input.turnId, notice);
  }
  beginLiveNoticeSend(input.turnId);
  if (input.stageOnly) return { delivered: false, pending: true };
  if (notice.messageId) {
    input.journal.markNoticeDelivered(input.turnId);
    endLiveNoticeSend(input.turnId);
    return { delivered: true, pending: false };
  }
  if (input.journal.isDelivering(noticeDeliveryKey(input.turnId))) {
    return { delivered: false, pending: true };
  }
  try {
    const sent = await input.journal.withDelivery(noticeDeliveryKey(input.turnId), async () => {
      await postNotice(input.send, { ...entry, notice }, notice, input.noticeAuth, input.journal);
      return true;
    });
    if (sent !== true) return { delivered: false, pending: true };
    input.journal.markNoticeDelivered(input.turnId);
    log.info('notice', 'sent', { turnId: input.turnId, kind: notice.kind, consecutive: input.consecutive });
    return { delivered: true, pending: false };
  } catch (error) {
    log.warn('notice', 'send-failed', {
      turnId: input.turnId,
      err: error instanceof Error ? error.message : String(error),
    });
    return { delivered: false, pending: true };
  } finally {
    endLiveNoticeSend(input.turnId);
  }
}

async function sendAuthNotice(
  input: {
    send: NoticeSender;
    journal: TurnJournal;
    turnId: string;
    ownerId?: string;
    stageOnly?: boolean;
  },
  entry: TurnJournalEntry,
): Promise<{ delivered: boolean; pending: boolean }> {
  const existing = entry.status === 'notice-pending' ? entry.notice : undefined;
  const notice: TurnNotice = existing ?? {
    kind: 'auth',
    recipientChatId: entry.chatId,
    markdown: buildAuthInitiatorMarkdown(entry.initiatorId || entry.senderId),
    replyTo: entry.messageIds.at(-1),
    ...(entry.threadId ? { replyInThread: true } : {}),
    ...(input.ownerId ? { ownerChatId: input.ownerId } : {}),
    deliveryId: randomUUID(),
  };
  if (!existing) input.journal.markNoticePending(input.turnId, notice);
  if (input.stageOnly) return { delivered: false, pending: true };
  if (notice.messageId || (notice.initiatorDelivered && (!notice.ownerChatId || notice.ownerDelivered))) {
    input.journal.markNoticeDelivered(input.turnId);
    return { delivered: true, pending: false };
  }
  if (input.journal.isDelivering(noticeDeliveryKey(input.turnId))) {
    return { delivered: false, pending: true };
  }
  try {
    const ok = await sendAuthPayload(input.send, { ...entry, notice }, notice, input.journal);
    if (ok) {
      input.journal.markNoticeDelivered(input.turnId);
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
      const result = await send(next.recipientChatId, { markdown: next.markdown }, sendOpts(entry, next));
      requireReceipt(result, 'auth-initiator');
      next.initiatorDelivered = true;
      journal?.update(entry.turnId, { notice: next });
    }
    if (next.ownerChatId && !next.ownerDelivered) {
      const result = await send(next.ownerChatId, { markdown: buildAuthOwnerMarkdown() });
      requireReceipt(result, 'auth-owner');
      next.ownerDelivered = true;
      journal?.update(entry.turnId, { notice: next });
    }
    return Boolean(next.initiatorDelivered && (!next.ownerChatId || next.ownerDelivered));
  } catch (error) {
    journal?.update(entry.turnId, { notice: next });
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
  journal.update(turnId, { notice: { ...current, messageId } });
}

function sendOpts(
  entry: TurnJournalEntry,
  notice: TurnNotice,
): { replyTo?: string; replyInThread?: boolean } {
  const replyTo = notice.replyTo ?? entry.messageIds.at(-1);
  return {
    ...(replyTo ? { replyTo } : {}),
    ...(notice.replyInThread || entry.threadId ? { replyInThread: true } : {}),
  };
}

function requireReceipt(result: { messageId?: string }, type: string): void {
  if (!result.messageId?.trim()) throw new Error(`${type} notice missing message receipt`);
}
