import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import * as lockfile from 'proper-lockfile';
import { sendManagedCard } from '../card/managed';
import { log } from '../core/logger';
import { classify, isGoneMessage, isNotInChat } from '../bot/feishu-error';
import { automationBoardCard, chatStatusSnapshot } from './board-card';
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
  botDisplayName: () => string;
  now?: () => number;
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
  private readonly botDisplayName: () => string;
  private readonly now: () => number;
  private readonly lockPath: string;
  private readonly onNotInChat?: (chatId: string) => void | Promise<unknown>;
  private tail: Promise<void> = Promise.resolve();
  private queued = false;
  private running = false;

  constructor(deps: AutomationBoardDeps) {
    this.store = deps.store;
    this.channel = deps.channel;
    this.auth = deps.auth;
    this.botDisplayName = deps.botDisplayName;
    this.now = deps.now ?? Date.now;
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
      (error) => { log.fail('auto', error, { event: 'board' }); },
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
      try {
        const items = this.store.list().filter((item) => item.chatId === chatId);
        const binding = this.store.getBoard(chatId);
        if (items.length === 0 && !binding) return;
        const snapshot = await this.store.readStatus();
        const status = chatStatusSnapshot(snapshot, items, {
          bot: this.botDisplayName(),
          updatedAt: this.now(),
        });
        const card = automationBoardCard({ items, status, auth: this.auth });
        const next = await this.patchOrResend(chatId, binding, card);
        if (!this.store.getBoard(chatId) && this.store.list().every((item) => item.chatId !== chatId)) {
          return;
        }
        if (items.length === 0) await this.ensureUnpinned(next);
        else {
          await this.ensurePinned(chatId, next, {
            repin: binding?.messageId === next.messageId,
          });
        }
      } catch (error) {
        if (isNotInChat(error)) {
          void Promise.resolve(this.onNotInChat?.(chatId)).catch((next) => {
            log.fail('auto', next, { event: 'removed-from-chat', chatId });
          });
          return;
        }
        throw error;
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
        if (!isGoneMessage(error)) throw error;
        log.warn('auto', 'board.resend', { chatId });
        await this.unpinQuietly(binding.messageId);
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
      await this.channel.updateCardById(binding.cardId, card, sequence);
      await this.store.setBoard({ ...binding, sequence });
      return;
    }
    await this.channel.updateCard(binding.messageId, card);
  }

  private async ensurePinned(
    chatId: string,
    binding: AutomationBoardBinding,
    opts: { repin: boolean },
  ): Promise<void> {
    try {
      const pinned = await listPinnedMessageIds(this.channel, chatId);
      if (pinned.includes(binding.messageId)) return;
      await pinMessage(this.channel, binding.messageId);
      if (opts.repin) log.info('auto', 'board.repin', { chatId });
    } catch (error) {
      if (isNotInChat(error)) throw error;
      log.fail('auto', error, { event: 'board.pin', chatId });
      await this.hintPinFailed(chatId, binding);
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
