import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import * as lockfile from 'proper-lockfile';
import { readCardApiError } from '../card/card-api-error';
import { updateCardByCardId } from '../card/cardkit-update';
import { sendManagedCard } from '../card/managed';
import { log } from '../core/logger';
import { classify, isNotInChat } from '../bot/feishu-error';
import { automationBoardCard, automationBoardSettledCard } from './board-card';
import { listPinnedMessageIds, pinMessage, unpinMessage } from './board-pins';
import type { BoardActionAuth } from './board-auth';
import { monotonicCardSequence } from './card-sequence';
import type {
  AutomationBoardBinding,
  AutomationsStore,
  PendingUnpinBoard,
  PendingUnpinMessageRef,
} from './store';

export const AUTO_PIN_FAILED_HINT = '看板置顶失败，任务不受影响。';

export interface AutomationBoard {
  refresh(): Promise<void>;
  idle(): Promise<void>;
}

export interface AutomationBoardDeps {
  store: AutomationsStore;
  channel: LarkChannel;
  auth: BoardActionAuth;
  lockPath: string;
  onNotInChat?: (chatId: string) => void | Promise<unknown>;
  now?: () => number;
}

export function createAutomationBoard(deps: AutomationBoardDeps): AutomationBoard {
  return new Board(deps);
}

class Board implements AutomationBoard {
  private readonly store: AutomationsStore;
  private readonly channel: LarkChannel;
  private readonly auth: BoardActionAuth;
  private readonly lockPath: string;
  private readonly onNotInChat?: (chatId: string) => void | Promise<unknown>;
  private readonly now: () => number;
  /** Highest CardKit sequence already sent for a card in this process. Not persisted. */
  private readonly attemptedSequence = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  private queued = false;
  private running = false;
  /** Non-link create/update failures, keyed by chat and card content. */
  private readonly failedAttempt = new Map<string, string>();
  /** Last pending-list length already warned for a chat. Not persisted. */
  private readonly pendingOverflowLogged = new Map<string, number>();

  constructor(deps: AutomationBoardDeps) {
    this.store = deps.store;
    this.channel = deps.channel;
    this.auth = deps.auth;
    this.lockPath = deps.lockPath;
    this.onNotInChat = deps.onNotInChat;
    this.now = deps.now ?? Date.now;
  }

  refresh(): Promise<void> {
    return this.enqueue(() => this.renderAll());
  }

  idle(): Promise<void> {
    return this.tail;
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    if (this.running) {
      this.queued = true;
      return this.tail;
    }
    this.running = true;
    const run = this.tail.then(fn).then(async () => {
      while (this.queued) {
        this.queued = false;
        await fn();
      }
    }).finally(() => {
      this.running = false;
    });
    this.tail = run.then(
      () => {},
      (error) => {
        const api = readCardApiError(error);
        log.fail('auto', error, {
          event: 'board',
          ...(api.code !== undefined ? { code: api.code } : {}),
          ...(api.msg !== undefined ? { msg: api.msg } : {}),
        });
      },
    );
    return run;
  }

  private async renderAll(): Promise<void> {
    const chats = new Set<string>();
    for (const item of this.store.list()) chats.add(item.chatId);
    for (const board of this.store.listBoards()) chats.add(board.chatId);
    for (const chatId of chats) {
      await this.renderChat(chatId);
    }
  }

  private async renderChat(chatId: string): Promise<void> {
    await withBoardLock(this.lockPath, async () => {
      let attemptKey: string | undefined;
      try {
        const items = this.store.list().filter((item) => item.chatId === chatId);
        const binding = this.store.getBoard(chatId);
        if (items.length === 0 && !binding) return;
        const card = automationBoardCard({ items, auth: this.auth });
        attemptKey = boardAttemptKey(card);
        if (this.failedAttempt.get(chatId) === attemptKey) return;
        const outcome = await this.patchOrResend(chatId, binding, card);
        this.failedAttempt.delete(chatId);
        const next = outcome.binding;
        if (!this.store.getBoard(chatId) && this.store.list().every((item) => item.chatId !== chatId)) {
          return;
        }
        if (items.length === 0) {
          if (outcome.applied) await this.ensureUnpinned(next);
          await this.releasePendingUnpin(next, { settle: false });
          return;
        }
        if (outcome.applied) {
          const pinned = await this.ensurePinned(chatId, next, {
            repin: binding?.messageId === next.messageId,
          });
          if (!pinned) return;
        } else if (
          !next.pendingUnpinMessageIds?.length
          || !(await this.currentMessagePinned(chatId, next.messageId))
        ) {
          return;
        }
        await this.releasePendingUnpin(next, { settle: true });
      } catch (error) {
        if (isNotInChat(error)) {
          void Promise.resolve(this.onNotInChat?.(chatId)).catch((next) => {
            log.fail('auto', next, { event: 'removed-from-chat', chatId });
          });
          return;
        }
        if (classify(error) === 'link') throw error;
        const api = readCardApiError(error);
        // A Feishu code means the card request itself was rejected. Persist and
        // pin failures have no code and must be retried on the next refresh.
        if (api.code === undefined) throw error;
        if (attemptKey !== undefined) this.failedAttempt.set(chatId, attemptKey);
        log.fail('auto', error, {
          event: 'board',
          chatId,
          code: api.code,
          ...(api.msg !== undefined ? { msg: api.msg } : {}),
        });
      }
    });
  }

  private async patchOrResend(
    chatId: string,
    binding: AutomationBoardBinding | undefined,
    card: object,
  ): Promise<BoardPatchOutcome> {
    if (!binding) return this.sendReplacement(chatId, undefined, card);
    try {
      return await this.patch(binding, card);
    } catch (error) {
      if (isNotInChat(error)) throw error;
      if (classify(error) === 'link') throw error;
      if (!binding.cardId) logPatchFailed(error, undefined);
      const reason = boardResendReason(error);
      if (!reason) return { binding, applied: false };
      log.warn('auto', 'board.resend', { chatId, reason });
      return this.sendReplacement(chatId, binding, card);
    }
  }

  private async patch(binding: AutomationBoardBinding, card: object): Promise<BoardPatchOutcome> {
    if (!binding.cardId) {
      await this.channel.updateCard(binding.messageId, card);
      return { binding, applied: true };
    }
    const sequence = this.nextSequence(binding);
    try {
      await updateCardByCardId(this.channel, binding.cardId, card, sequence);
    } catch (error) {
      if (isNotInChat(error) || classify(error) === 'link') throw error;
      logPatchFailed(error, sequence);
      if (readCardApiError(error).code !== 300317) throw error;
      return this.retrySequence(binding, card);
    }
    await this.persistSequence(binding, sequence);
    logPatch(binding.cardId, sequence, false);
    return { binding: { ...binding, sequence }, applied: true };
  }

  private async retrySequence(binding: AutomationBoardBinding, card: object): Promise<BoardPatchOutcome> {
    const cardId = binding.cardId;
    if (!cardId) return { binding, applied: false };
    const sequence = this.nextSequence(binding);
    try {
      await updateCardByCardId(this.channel, cardId, card, sequence);
    } catch (error) {
      if (isNotInChat(error) || classify(error) === 'link') throw error;
      logPatchFailed(error, sequence);
      // The one retry already failed. Keep the binding; the next refresh uses a higher sequence.
      return { binding, applied: false };
    }
    await this.persistSequence(binding, sequence);
    logPatch(cardId, sequence, true);
    return { binding: { ...binding, sequence }, applied: true };
  }

  private nextSequence(binding: {
    cardId?: string;
    messageId: string;
    sequence?: number;
  }): number {
    const key = binding.cardId ?? binding.messageId;
    const attempted = this.attemptedSequence.get(key) ?? 0;
    const sequence = monotonicCardSequence(binding.sequence, this.now(), attempted);
    this.attemptedSequence.set(key, sequence);
    return sequence;
  }

  private async persistSequence(binding: AutomationBoardBinding, sequence: number): Promise<void> {
    const live = this.store.getBoard(binding.chatId) ?? binding;
    if (live.cardId !== binding.cardId || live.messageId !== binding.messageId) return;
    await this.store.setBoard({ ...live, sequence });
  }

  private async sendReplacement(
    chatId: string,
    binding: AutomationBoardBinding | undefined,
    card: object,
  ): Promise<BoardPatchOutcome> {
    const sent = await sendManagedCard(this.channel, chatId, card);
    const pendingUnpinMessageIds = appendPendingUnpin(binding, sent.messageId);
    const next: AutomationBoardBinding = {
      chatId,
      messageId: sent.messageId,
      ...(sent.kind === 'card-id' && sent.cardId ? { cardId: sent.cardId } : {}),
      ...(pendingUnpinMessageIds ? { pendingUnpinMessageIds } : {}),
    };
    await this.store.setBoard(next);
    if (pendingUnpinMessageIds) this.notePendingOverflow(chatId, pendingUnpinMessageIds.length);
    return { binding: next, applied: true };
  }

  private async ensurePinned(
    chatId: string,
    binding: AutomationBoardBinding,
    opts: { repin: boolean },
  ): Promise<boolean> {
    try {
      const pinned = await listPinnedMessageIds(this.channel, chatId);
      if (pinned.includes(binding.messageId)) return true;
      await pinMessage(this.channel, binding.messageId);
      if (opts.repin) log.info('auto', 'board.repin', { chatId });
      return true;
    } catch (error) {
      if (isNotInChat(error)) throw error;
      log.fail('auto', error, { event: 'board.pin', chatId });
      await this.hintPinFailed(chatId, binding);
      return false;
    }
  }

  private async currentMessagePinned(chatId: string, messageId: string): Promise<boolean> {
    try {
      const pinned = await listPinnedMessageIds(this.channel, chatId);
      return pinned.includes(messageId);
    } catch (error) {
      if (isNotInChat(error)) throw error;
      log.fail('auto', error, { event: 'board.pin', chatId });
      return false;
    }
  }

  private async ensureUnpinned(binding: AutomationBoardBinding): Promise<void> {
    await this.unpinQuietly(binding.messageId);
  }

  private async unpinQuietly(messageId: string): Promise<void> {
    try {
      await unpinMessage(this.channel, messageId);
    } catch (error) {
      if (isNotInChat(error)) throw error;
      log.warn('auto', 'board.unpin-failed', {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async releasePendingUnpin(
    binding: AutomationBoardBinding,
    opts: { settle: boolean },
  ): Promise<void> {
    const live = this.store.getBoard(binding.chatId) ?? binding;
    const pending = live.pendingUnpinMessageIds ?? [];
    if (pending.length === 0) return;
    const remaining: PendingUnpinMessageRef[] = [];
    let changed = false;
    for (const ref of pending) {
      const messageId = pendingUnpinRefMessageId(ref);
      if (messageId === live.messageId) {
        changed = true;
        continue;
      }
      let nextRef = ref;
      if (opts.settle) {
        const settled = await this.settlePending(nextRef);
        if (settled.changed) {
          nextRef = settled.ref;
          changed = true;
        }
      }
      let unpinned = false;
      try {
        await unpinMessage(this.channel, messageId);
        unpinned = true;
      } catch (error) {
        if (isNotInChat(error)) throw error;
        log.warn('auto', 'board.unpin-failed', {
          err: error instanceof Error ? error.message : String(error),
        });
      }
      if (unpinned) {
        changed = true;
        continue;
      }
      remaining.push(nextRef);
    }
    if (!changed) return;
    const latest = this.store.getBoard(binding.chatId);
    if (!latest || latest.messageId !== live.messageId) return;
    await this.store.setBoard({
      ...latest,
      pendingUnpinMessageIds: remaining,
    });
    this.notePendingOverflow(binding.chatId, remaining.length);
  }

  /**
   * One settle attempt. A stale sequence is not retried here; the next refresh
   * uses a higher sequence. Expired entities are logged and left pending.
   */
  private async settlePending(
    ref: PendingUnpinMessageRef,
  ): Promise<{ ref: PendingUnpinMessageRef; changed: boolean }> {
    const entry = asPendingUnpinBoard(ref);
    if (entry.settled || !entry.cardId) return { ref, changed: false };
    const sequence = this.nextSequence({
      messageId: entry.messageId,
      cardId: entry.cardId,
      sequence: entry.sequence,
    });
    try {
      await updateCardByCardId(
        this.channel,
        entry.cardId,
        automationBoardSettledCard(),
        sequence,
      );
    } catch (error) {
      if (isNotInChat(error) || classify(error) === 'link') throw error;
      logPatchFailed(error, sequence);
      return { ref, changed: false };
    }
    logPatch(entry.cardId, sequence, false);
    return {
      ref: {
        messageId: entry.messageId,
        cardId: entry.cardId,
        sequence,
        settled: true,
      },
      changed: true,
    };
  }

  private notePendingOverflow(chatId: string, count: number): void {
    if (count <= 5) {
      this.pendingOverflowLogged.delete(chatId);
      return;
    }
    if (this.pendingOverflowLogged.get(chatId) === count) return;
    this.pendingOverflowLogged.set(chatId, count);
    log.warn('auto', 'board.pending-overflow', { count });
  }

  private async hintPinFailed(chatId: string, binding: AutomationBoardBinding): Promise<void> {
    if (binding.pinFailedHinted) return;
    try {
      await this.channel.send(chatId, { markdown: AUTO_PIN_FAILED_HINT });
    } catch (error) {
      if (isNotInChat(error)) throw error;
      log.warn('auto', 'board.pin-hint-failed', {
        err: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    await this.store.setBoard({ ...binding, pinFailedHinted: true });
  }
}

interface BoardPatchOutcome {
  binding: AutomationBoardBinding;
  /** False when the card body was not accepted and the same binding is kept. */
  applied: boolean;
}

type BoardResendReason = '200740' | '200750' | 'message-deleted';

/**
 * Resend only when the card entity or the message cannot be updated.
 * 200740 / 200750: CardKit entity missing or expired.
 * 230110 / 230011 / 10020 / 10037: message deleted, recalled, or id not found.
 * HTTP 404 with no Feishu code: message not found.
 * 300311 is an app-permission error on an entity that still exists, so it is not a reason.
 * 300317 is a stale sequence; the caller retries in place.
 */
function boardResendReason(error: unknown): BoardResendReason | undefined {
  const code = readCardApiError(error).code;
  if (code === 200740) return '200740';
  if (code === 200750) return '200750';
  if (code === 230110 || code === 230011 || code === 10020 || code === 10037) return 'message-deleted';
  if (code === undefined && responseStatus(error) === 404) return 'message-deleted';
  return undefined;
}

function responseStatus(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const rec = current as { response?: { status?: unknown }; status?: unknown; cause?: unknown };
    if (typeof rec.response?.status === 'number') return rec.response.status;
    current = rec.cause;
  }
  return undefined;
}

function logPatch(cardId: string, sequence: number, retry: boolean): void {
  log.info('auto', 'board.patch', {
    cardId: cardId.slice(-4),
    sequence,
    retry,
  });
}

function logPatchFailed(error: unknown, sequence: number | undefined): void {
  const api = readCardApiError(error);
  const msg = api.msg ?? (error instanceof Error ? error.message : undefined);
  log.warn('auto', 'board.patch-failed', {
    ...(api.code !== undefined ? { code: api.code } : {}),
    ...(msg !== undefined ? { msg } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
  });
}

function appendPendingUnpin(
  binding: AutomationBoardBinding | undefined,
  nextMessageId: string,
): PendingUnpinMessageRef[] | undefined {
  if (!binding) return undefined;
  const pending = (binding.pendingUnpinMessageIds ?? []).filter(
    (ref) => pendingUnpinRefMessageId(ref) !== nextMessageId,
  );
  if (
    binding.messageId
    && binding.messageId !== nextMessageId
    && !pending.some((ref) => pendingUnpinRefMessageId(ref) === binding.messageId)
  ) {
    pending.push(pendingEntryFromBinding(binding));
  }
  return pending.length > 0 ? pending : undefined;
}

function pendingEntryFromBinding(binding: AutomationBoardBinding): PendingUnpinMessageRef {
  if (!binding.cardId && typeof binding.sequence !== 'number') return binding.messageId;
  return {
    messageId: binding.messageId,
    ...(binding.cardId ? { cardId: binding.cardId } : {}),
    ...(typeof binding.sequence === 'number' && binding.sequence > 0
      ? { sequence: binding.sequence }
      : {}),
  };
}

function pendingUnpinRefMessageId(ref: PendingUnpinMessageRef): string {
  if (typeof ref === 'string') return ref;
  return ref.messageId;
}

function asPendingUnpinBoard(ref: PendingUnpinMessageRef): PendingUnpinBoard {
  if (typeof ref === 'string') return { messageId: ref };
  return ref;
}

function boardAttemptKey(card: object): string {
  return JSON.stringify(redactBoardAttempt(card));
}

function redactBoardAttempt(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((entry) => redactBoardAttempt(entry));
  if (!node || typeof node !== 'object') return node;
  const rec: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'auto_token' && typeof value === 'string') {
      rec[key] = '';
      continue;
    }
    if (key === 'a' && typeof value === 'string' && 'auto_token' in node) {
      rec[key] = '';
      continue;
    }
    if (key === 'content' && typeof value === 'string' && value.includes('"v":1')) {
      rec[key] = value.replace(/"updatedAt":\d+/g, '"updatedAt":0');
      continue;
    }
    rec[key] = redactBoardAttempt(value);
  }
  return rec;
}

async function withBoardLock(path: string, fn: () => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '', { flag: 'a', mode: 0o600 });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 5, minTimeout: 20, maxTimeout: 80 },
    });
  } catch (error) {
    log.warn('auto', 'board.lock-busy', {
      err: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  try {
    await fn();
  } finally {
    await release();
  }
}
