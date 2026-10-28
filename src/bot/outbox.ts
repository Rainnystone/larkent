import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';
import type { RunState } from '../card/run-state';
import type { RunOutcome } from './run-outcome';
import { withDeliveryUuid } from './feishu-delivery';
import { streamDeliveryKey, replyState, noticeState } from './turn-journal';
import { classify, rateLimitResetDelayMs, isNotInChat } from './feishu-error';
import { RECOVERY_RETRY_MAX_MS } from './recovery-timing';
import { deliverDraftCard, stageDraftCard, type DraftCardInput, type DraftCardReceipts } from './outbox-draft';

import type {
  TurnJournal,
  TurnJournalEntry,
  JournalRecoverOptions,
} from './turn-journal';
import {
  deliverFinalReply,
  resendJournalReply,
  recallIfEmptyStreamedReply,
  stagedOutboxCount,
} from './outbox-reply';
import {
  resendPendingNotice,
  deliverInterruptionNotice,
  stageInterruptionNotice,
  authNoticeAlreadyDelivered,
} from './outbox-notice';
import {
  NOTICE_RESTART_GAP_MS,
  type NoticeActionAuth,
} from './interruption-notice';

const OUTBOX_SWEEP_MS = 50;
const OUTBOX_IDLE_MS = 60_000;

export type { StreamDelivery } from './outbox-reply';

type FinalReply = Omit<
  Parameters<typeof deliverFinalReply>[0],
  'channel' | 'journal' | 'link'
>;

export interface OutboxOptions {
  channel: LarkChannel;
  journal?: TurnJournal;
  botAppId: string;
  isDown?: () => boolean;
  isActive?: (scope: string) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  noticeAuth?: NoticeActionAuth;
  onInterrupted?: JournalRecoverOptions['onInterrupted'];
  track?: (work: Promise<void>) => Promise<void>;
  onNotInChat?: (chatId: string) => void | Promise<unknown>;
  draftCards?: DraftCardReceipts;
  draftJournal?: TurnJournal;
  liveSweep?: boolean;
}

/** Owns durable reply and notice delivery; the journal stores the atomic turn snapshot. */
export class Outbox {
  private redelivering: Promise<void> | undefined;
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private sweepDelayMs = OUTBOX_SWEEP_MS;
  private sweepInFlight = false;
  private sweepQueued = false;
  private sweepTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: OutboxOptions) {}

  async stageDraftCard(input: DraftCardInput): Promise<void> {
    const journal = this.options.draftJournal ?? this.options.journal;
    if (!journal) throw new Error('Draft Outbox is unavailable');
    stageDraftCard(journal, input);
    await journal.flush();
  }

  async deliverDraftCard(input: DraftCardInput) {
    const journal = this.options.draftJournal ?? this.options.journal;
    if (!journal || !this.options.draftCards) throw new Error('Draft Outbox is unavailable');
    await this.stageDraftCard(input);
    try {
      const receipt = await deliverDraftCard({ ...this.options, journal, draftCards: this.options.draftCards }, input.deliveryId);
      if (!receipt) throw new Error('draft card delivery is unknown or pending');
      return receipt;
    } catch (error) {
      if (journal.getDraftCard(input.deliveryId)?.state === 'staged') this.schedule(OUTBOX_SWEEP_MS);
      throw error;
    }
  }

  async reconcileDraftCard(deliveryId: string): Promise<void> {
    const journal = this.options.draftJournal ?? this.options.journal;
    if (!journal || !this.options.draftCards) return;
    await deliverDraftCard({ ...this.options, journal, draftCards: this.options.draftCards }, deliveryId);
  }

  stream(
    chatId: string,
    input: Parameters<LarkChannel['stream']>[1],
    options: { replyTo: string; replyInThread?: boolean },
    turnId?: string,
  ): ReturnType<LarkChannel['stream']> {
    return this.options.channel.stream(
      chatId,
      input,
      withDeliveryUuid(options, turnId ? streamDeliveryKey(turnId) : undefined),
    );
  }

  recallEmptyStream(
    progress: {
      opened(): boolean;
      abandoned(): boolean;
      settled: Promise<unknown>;
    },
    state: RunState,
    scope: string,
  ): Promise<void> {
    return recallIfEmptyStreamedReply(
      this.options.channel,
      progress,
      state,
      scope,
    );
  }

  async deliverNotice(input: {
    turnId: string;
    outcome: RunOutcome;
    consecutive: number;
    requireBotMention: boolean;
    ownerId?: string;
  }): Promise<boolean> {
    const { journal, noticeAuth } = this.options;
    if (!journal) return false;
    const args = {
      ...input,
      journal,
      noticeAuth,
      authNotified: authNoticeAlreadyDelivered(journal),
    };
    stageInterruptionNotice(args);
    await journal.flush();
    const current = journal.get(input.turnId);
    if (
      !current ||
      noticeState(current) !== 'staged' ||
      this.options.isDown?.()
    )
      return false;
    const result = await deliverInterruptionNotice({
      ...args,
      send: (...args) => this.options.channel.send(...args),
    });
    if (!result.delivered) this.schedule();
    return result.delivered;
  }

  reapOrphans(): Promise<void> {
    return (
      this.options.journal?.reapOrphans({
        isDown: this.options.isDown,
        isActive: this.options.isActive,
        onInterrupted: this.options.onInterrupted,
      }) ?? Promise.resolve()
    );
  }

  deliverFinalReply(input: FinalReply): Promise<void> {
    return deliverFinalReply({
      ...input,
      channel: this.options.channel,
      journal: this.options.journal,
      onWait: input.onWait ?? ((delayMs) => this.schedule(delayMs)),
      onNotInChat: input.onNotInChat ?? this.options.onNotInChat,
      link: { isDown: () => this.options.isDown?.() ?? false },
    });
  }

  async deliverAutomation(input: {
    kind: 'reminder' | 'result';
    turnId: string;
    chatId: string;
    markdown: string;
    actor: string;
    scope?: string;
  }): Promise<void> {
    const journal = this.options.journal;
    if (!journal) return;
    const existing = journal.get(input.turnId);
    if (existing && replyState(existing) !== undefined) {
      if (replyState(existing) !== 'staged') return;
    } else {
      if (!existing) journal.enqueue({
        turnId: input.turnId, scope: input.scope ?? `auto:${input.turnId}`,
        chatId: input.chatId, messageIds: [], senderId: input.actor,
        initiatorId: input.actor, initiatorType: 'bot', status: 'settled',
      });
      journal.stageReply(input.turnId, {
        kind: input.kind, markdown: input.markdown, replyTo: '', replyMode: 'text',
      });
    }
    await journal.flush();
    if (this.options.isDown?.()) return;
    const current = journal.get(input.turnId);
    if (!current || current.status === 'voided') return;
    try {
      if (!await this.deliver(current)) this.schedule();
    } catch (error) {
      if (isNotInChat(error)) {
        journal.replyRejected(current.turnId);
        await journal.flush();
        throw error;
      }
      try { this.redeliveryFailed('reply', current, error); }
      catch { /* The link owns recovery after a transport failure. */ }
      await journal.flush();
      this.schedule();
    }
  }

  async stage(
    item:
      | {
          kind: 'reply';
          turnId: string;
          payload: Parameters<TurnJournal['stageReply']>[1];
        }
      | {
          kind: 'notice';
          turnId: string;
          payload: Parameters<TurnJournal['stageNotice']>[1];
        },
  ): Promise<string | undefined> {
    const journal = this.options.journal;
    if (!journal) return undefined;
    if (item.kind === 'reply') journal.stageReply(item.turnId, item.payload);
    else journal.stageNotice(item.turnId, item.payload);
    await journal.flush();
    return journal.get(item.turnId)?.[item.kind]?.deliveryId;
  }

  voidScope(scope: string): void {
    this.options.journal?.voidScope(scope);
  }

  async deliver(entry: TurnJournalEntry): Promise<boolean> {
    const journal = this.options.journal;
    if (!journal || this.options.isDown?.()) return false;
    await journal.flush();
    const current = journal.get(entry.turnId);
    if (!current || this.options.isDown?.()) return false;
    const state = replyState(current);
    if (state === 'sent') return true;
    if (state !== 'staged') return false;
    try {
      const delivered = await resendJournalReply({
        ...this.options,
        journal,
        entry: current,
      });
      if (delivered) journal.replyDelivered(entry.turnId);
      await journal.flush();
      return delivered;
    } catch (error) {
      if (isNotInChat(error)) await this.options.onNotInChat?.(entry.chatId);
      throw error;
    }
  }

  redeliver(): Promise<void> {
    if (!this.options.journal && !this.options.draftJournal) return Promise.resolve();
    if (this.redelivering) return this.redelivering;
    this.redelivering = this.finishRedeliver().finally(() => {
      this.redelivering = undefined;
    });
    return this.redelivering;
  }

  private async finishRedeliver(): Promise<void> {
    const journal = (this.options.journal ?? this.options.draftJournal)!;
    try {
      await journal.flush();
      await this.redeliverOwned();
    } catch (error) {
      await journal.flush().catch(() => {});
      throw error;
    }
    await journal.flush();
  }

  private async redeliverOwned(): Promise<void> {
    const journal = (this.options.journal ?? this.options.draftJournal)!;
    const snapshot = journal
      .list()
      .filter((entry) => isStagedReply(entry) || isStagedNotice(entry));
    let resent = 0;
    let notices = 0;
    const pendingNoticeCount = snapshot.filter(isStagedNotice).length;
    for (const entry of snapshot) {
      if (this.options.isDown?.()) break;
      const current = journal.get(entry.turnId);
      if (!current) continue;
      if (isStagedReply(current)) {
        if (current.cliAlreadySent) journal.replyDelivered(current.turnId);
        else {
          try {
            if (await this.deliver(current)) resent += 1;
          } catch (error) {
            this.redeliveryFailed('reply', current, error);
          }
        }
      }
      if (this.options.isDown?.()) break;
      const latest = journal.get(entry.turnId);
      if (
        !latest ||
        !isStagedNotice(latest) ||
        this.options.isActive?.(latest.scope)
      )
        continue;
      if (latest.notice?.messageId) {
        journal.noticeDelivered(latest.turnId);
        continue;
      }
      try {
        const delivered = await resendPendingNotice({
          send: (...args) => this.options.channel.send(...args),
          entry: latest,
          journal,
          noticeAuth: this.options.noticeAuth,
        });
        if (delivered) {
          journal.noticeDelivered(latest.turnId);
          notices += 1;
          if (notices < pendingNoticeCount)
            await (this.options.sleep ?? defaultSleep)(NOTICE_RESTART_GAP_MS);
        }
      } catch (error) {
        this.redeliveryFailed('notice', latest, error);
      }
    }
    if (resent > 0 || notices > 0)
      log.info('journal', 'recovered', {
        orphans: 0,
        resent,
        notices,
        interrupted: 0,
      });
    const draftJournal = this.options.draftJournal ?? journal;
    for (const item of draftJournal.listDraftCards()) {
      if (this.options.isDown?.()) break;
      if (item.state !== 'staged' || !this.options.draftCards) continue;
      try { await this.reconcileDraftCard(item.deliveryId); }
      catch (error) {
        if (isNotInChat(error)) await this.options.onNotInChat?.(item.target.chatId);
        if (classify(error) === 'link') throw error;
      }
    }
  }

  private redeliveryFailed(
    item: 'reply' | 'notice',
    entry: TurnJournalEntry,
    error: unknown,
  ): void {
    const kind = classify(error);
    log.warn(
      'journal',
      kind === 'rejected'
        ? 'resend-rejected'
        : item === 'reply'
          ? 'resend-failed'
          : 'notice-resend-failed',
      {
        turnId: entry.turnId,
        err: error instanceof Error ? error.message : String(error),
      },
    );
    switch (kind) {
      case 'rejected':
        if (item === 'reply') this.options.journal!.replyRejected(entry.turnId);
        else this.options.journal!.noticeRejected(entry.turnId);
        return;
      case 'link':
        throw error;
      case 'local':
        return;
      default: {
        const exhaustive: never = kind;
        throw exhaustive;
      }
    }
  }

  schedule(delayMs = 0): void {
    if (this.stopped || this.options.liveSweep === false) return;
    this.sweepDelayMs = OUTBOX_SWEEP_MS;
    if (delayMs > 0) {
      this.armSweep(delayMs);
      return;
    }
    void this.sweep();
  }

  sweep(): Promise<void> {
    const journal = this.options.journal ?? this.options.draftJournal;
    if (this.stopped || !journal || this.options.isDown?.())
      return Promise.resolve();
    if (this.sweepInFlight) {
      this.sweepQueued = true;
      return this.sweepTail;
    }
    this.sweepInFlight = true;
    const count = () => stagedOutboxCount(journal) + (this.options.draftJournal ?? journal).listDraftCards().filter(item => item.state === 'staged').length;
    const stagedBefore = count();
    const work = this.redeliver();
    this.sweepTail = (this.options.track?.(work) ?? work)
      .then(
        () => {
          if (this.stopped || this.options.isDown?.()) return;
          const stagedAfter = count();
          if (stagedAfter === 0) {
            this.sweepDelayMs = OUTBOX_SWEEP_MS;
            return;
          }
          this.armSweep(
            stagedAfter === stagedBefore ? OUTBOX_IDLE_MS : OUTBOX_SWEEP_MS,
          );
        },
        (error: unknown) => {
          if (this.stopped) return;
          const delay = rateLimitResetDelayMs(error) ?? this.sweepDelayMs;
          this.sweepDelayMs = Math.min(
            this.sweepDelayMs * 2,
            RECOVERY_RETRY_MAX_MS,
          );
          this.armSweep(delay);
        },
      )
      .finally(() => {
        this.sweepInFlight = false;
        if (!this.sweepQueued) return;
        this.sweepQueued = false;
        return this.sweep();
      });
    return this.sweepTail;
  }

  private armSweep(delayMs: number): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      void this.sweep();
    }, delayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
  }
}

function isStagedReply(entry: TurnJournalEntry): boolean {
  return replyState(entry) === 'staged';
}
function isStagedNotice(entry: TurnJournalEntry): boolean {
  return noticeState(entry) === 'staged';
}
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
