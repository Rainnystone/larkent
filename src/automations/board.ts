import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import * as lockfile from 'proper-lockfile';
import { readCardApiError } from '../card/card-api-error';
import { updateCardByCardId } from '../card/cardkit-update';
import { sendManagedCard } from '../card/managed';
import { log } from '../core/logger';
import { classify, isNotInChat } from '../bot/feishu-error';
import { automationBoardCard } from './board-card';
import { listPinnedMessageIds, pinMessage, unpinMessage } from './board-pins';
import type { BoardActionAuth } from './board-auth';
import type { AutomationBoardBinding, AutomationsStore } from './store';

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
  private tail: Promise<void> = Promise.resolve();
  private queued = false;
  private running = false;
  /** Non-link create/update failures, keyed by chat and card content. */
  private readonly failedAttempt = new Map<string, string>();

  constructor(deps: AutomationBoardDeps) {
    this.store = deps.store;
    this.channel = deps.channel;
    this.auth = deps.auth;
    this.lockPath = deps.lockPath;
    this.onNotInChat = deps.onNotInChat;
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
        const previousMessageId = binding?.messageId;
        const next = await this.patchOrResend(chatId, binding, card);
        this.failedAttempt.delete(chatId);
        if (!this.store.getBoard(chatId) && this.store.list().every((item) => item.chatId !== chatId)) {
          return;
        }
        if (items.length === 0) await this.ensureUnpinned(next);
        else {
          const pinned = await this.ensurePinned(chatId, next, {
            repin: binding?.messageId === next.messageId,
          });
          if (!pinned) return;
        }
        if (previousMessageId && previousMessageId !== next.messageId) {
          await this.unpinQuietly(previousMessageId);
        }
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
  ): Promise<AutomationBoardBinding> {
    if (binding) {
      try {
        await this.patch(binding, card);
        return binding;
      } catch (error) {
        if (isNotInChat(error)) throw error;
        if (classify(error) === 'link') throw error;
        const api = readCardApiError(error);
        log.fail('auto', error, {
          event: 'board',
          chatId,
          ...(api.code !== undefined ? { code: api.code } : {}),
          ...(api.msg !== undefined ? { msg: api.msg } : {}),
        });
        log.warn('auto', 'board.resend', { chatId });
      }
    }
    const sent = await sendManagedCard(this.channel, chatId, card);
    const next: AutomationBoardBinding = {
      chatId,
      messageId: sent.messageId,
      ...(sent.kind === 'card-id' && sent.cardId ? { cardId: sent.cardId } : {}),
    };
    await this.store.setBoard(next);
    return next;
  }

  private async patch(binding: AutomationBoardBinding, card: object): Promise<void> {
    if (binding.cardId) {
      const sequence = (binding.sequence ?? 0) + 1;
      await updateCardByCardId(this.channel, binding.cardId, card, sequence);
      await this.store.setBoard({ ...binding, sequence });
      return;
    }
    await this.channel.updateCard(binding.messageId, card);
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
