import { readFile } from 'node:fs/promises';
import { parseDraftCardItem, type DraftCardItem } from './outbox-draft-item';
import * as outboxState from './outbox-state';
import { replyState, noticeState, replyDeliveryKey, noticeDeliveryKey } from './outbox-state';
export { replyState, noticeState, replyDeliveryKey, noticeDeliveryKey, noticeOwnerDeliveryKey, streamDeliveryKey, FEISHU_DELIVERY_ID_MAX_CHARS } from './outbox-state';
import type { RunOutcome } from './run-outcome';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import { PersistenceQueue } from '../platform/persistence-queue';
import {
  isProcessAlive,
  processMatchesIdentity,
  readProcessStartMs,
} from '../platform/process-info';

export const TURN_JOURNAL_SCHEMA_VERSION = 2 as const;
export const TURN_JOURNAL_MAX_ENTRIES = 200;
export const TURN_JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const TURN_JOURNAL_ORPHAN_GRACE_MS = 2_000;

export type TurnJournalStatus =
  | 'queued'
  | 'running'
  | 'settled'
  | 'reply-delivered'
  | 'completed-undelivered'
  | 'interrupted'
  | 'notice-pending'
  | 'notice-delivered'
  | 'voided';

export type OutboxItemState = 'staged' | 'sent' | 'rejected' | 'voided';

export interface TurnReply {
  kind?: 'reminder' | 'result';
  markdown: string;
  replyTo: string;
  replyInThread?: boolean;
  /** Real Feishu thread_id when replyInThread. Never a parent message id. */
  threadId?: string;
  replyMode: string;
  deliveryId?: string;
  messageId?: string;
  /** True when the receipt is an interactive card (stream create or card send). */
  interactive?: boolean;
  /**
   * Message this reply replaces. Recovery recalls it after the replacement
   * send lands, and never treats that id as the correction itself.
   * The reply stays staged, with the correction receipt in `messageId`,
   * until recall succeeds, Feishu says this message is already gone, or the
   * recall is permanently rejected. Recovery must not send the correction
   * again while that receipt is known.
   */
  supersedes?: string;
  state?: OutboxItemState;
}

export type ContinuationStatus =
  | 'offered'
  | 'continue-requested'
  | 'continued'
  | 'abandoned'
  | 'voided'
  | 'dismissed';

export interface TurnContinuation {
  status: ContinuationStatus;
}

export interface TurnNotice {
  kind: 'continue' | 'plain' | 'auth';
  recipientChatId: string;
  markdown: string;
  replyTo?: string;
  replyInThread?: boolean;
  includeButtons?: boolean;
  ownerChatId?: string;
  initiatorDelivered?: boolean;
  ownerDelivered?: boolean;
  continueHint?: string;
  messageId?: string;
  deliveryId?: string;
  state?: OutboxItemState;
}

export interface TurnJournalEntry {
  turnId: string;
  scope: string;
  chatId: string;
  threadId?: string;
  messageIds: string[];
  senderId: string;
  initiatorId: string;
  /** Feishu sender_type of the turn initiator. `bot` means an app sender. */
  initiatorType?: 'user' | 'bot';
  resumeHandle?: string;
  policyFingerprint?: string;
  runId?: string;
  childPid?: number;
  childStartedAt?: number;
  status: TurnJournalStatus;
  outcome?: RunOutcome;
  noticeStatus?: 'none' | 'pending' | 'delivered';
  noticeInvalidated?: boolean;
  notice?: TurnNotice;
  continuation?: TurnContinuation;
  consecutiveInterrupts?: number;
  userInput?: string;
  resources?: TurnJournalResource[];
  reply?: TurnReply;
  cliAlreadySent?: boolean;
  /** Bot message ids for this turn that are not the final answer (notices, CoT, dedicated-final progress). */
  nonAnswerIds?: string[];
  createdAt: number;
  updatedAt: number;
}

export const TURN_JOURNAL_RESOURCE_TYPES = ['image', 'file', 'audio', 'video'] as const;
export type TurnJournalResourceType = (typeof TURN_JOURNAL_RESOURCE_TYPES)[number];

export interface TurnJournalResource {
  type: TurnJournalResourceType;
  fileKey: string;
  sourceMessageId: string;
}

export interface TurnJournalOptions {
  now?: () => number;
  maxEntries?: number;
  maxAgeMs?: number;
}

export interface JournalRecoverOptions {
  /** Crash recovery: notify the user that a running/queued turn was interrupted. */
  onInterrupted?: (entry: TurnJournalEntry) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  processStartMs?: (pid: number) => number | undefined;
  orphanGraceMs?: number;
  /** Live scopes owned by this process; skip orphan reaping for those entries. */
  isActive?: (scope: string) => boolean;
  /** I6: while the link is down, redeliver stages and returns. */
  isDown?: () => boolean;
}

interface JournalDocument {
  entries: TurnJournalEntry[];
  draftCards?: DraftCardItem[];
  upgrade?: boolean;
}

const TERMINAL_PRUNE: ReadonlySet<TurnJournalStatus> = new Set([
  'reply-delivered',
  'voided',
  'notice-delivered',
]);

export class TurnJournal {
  private readonly path: string;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private entries: TurnJournalEntry[] = [];
  private draftCards: DraftCardItem[] = [];
  private queue = new PersistenceQueue();
  private persistScheduled = false;
  private persistDirty = false;
  private loading: Promise<void> | undefined;
  private persistenceDisabled = false;
  private readonly enqueuedThisProcess = new Set<string>();

  constructor(path: string, opts: TurnJournalOptions = {}) {
    this.path = path;
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? TURN_JOURNAL_MAX_ENTRIES;
    this.maxAgeMs = opts.maxAgeMs ?? TURN_JOURNAL_MAX_AGE_MS;
  }

  getFilePath(): string {
    return this.path;
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.loadDocument().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  async flush(): Promise<void> {
    if (this.loading) await this.loading;
    if (this.persistenceDisabled) return;
    await this.queue.flush();
  }

  list(): TurnJournalEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  get(turnId: string): TurnJournalEntry | undefined {
    const entry = this.entries.find((item) => item.turnId === turnId);
    return entry ? { ...entry } : undefined;
  }

  listDraftCards(): DraftCardItem[] {
    return structuredClone(this.draftCards);
  }

  getDraftCard(deliveryId: string): DraftCardItem | undefined {
    const item = this.draftCards.find(item => item.deliveryId === deliveryId);
    return item ? structuredClone(item) : undefined;
  }

  stageDraftCard(item: DraftCardItem): void {
    if (this.persistenceDisabled) throw new Error('Turn journal is not writable');
    this.queue.assertHealthy();
    const existing = this.draftCards.find(entry => entry.deliveryId === item.deliveryId);
    if (existing) {
      if (existing.payload.draftId !== item.payload.draftId || existing.target.chatId !== item.target.chatId) throw new Error('Outbox deliveryId conflict');
      return;
    }
    this.draftCards.push(parseDraftCardItem(item, item.deliveryId));
    this.schedulePersist();
  }

  updateDraftCard(deliveryId: string, change: Pick<Partial<DraftCardItem>, 'state' | 'cardId' | 'receipt' | 'rejection'>): void {
    if (this.persistenceDisabled) throw new Error('Turn journal is not writable');
    this.queue.assertHealthy();
    const item = this.draftCards.find(entry => entry.deliveryId === deliveryId);
    if (!item || item.state === 'voided') return;
    if (item.cardId && change.cardId && item.cardId !== change.cardId) throw new Error('Outbox card entity conflict');
    if (item.receipt && change.receipt && (item.receipt.messageId !== change.receipt.messageId || item.receipt.cardId !== change.receipt.cardId)) throw new Error('Outbox receipt conflict');
    Object.assign(item, parseDraftCardItem({ ...item, ...change }, deliveryId));
    this.schedulePersist();
  }

  retainDraftCards(referenced: ReadonlySet<string>): void {
    if (this.persistenceDisabled) return;
    const kept = this.draftCards.filter(item => item.state === 'staged' || referenced.has(item.deliveryId));
    if (kept.length === this.draftCards.length) return;
    this.draftCards = kept;
    this.schedulePersist();
  }

  enqueue(input: Omit<TurnJournalEntry, 'createdAt' | 'updatedAt'>): TurnJournalEntry {
    const now = this.now();
    const entry: TurnJournalEntry = {
      ...input,
      messageIds: [...input.messageIds],
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    this.enqueuedThisProcess.add(entry.turnId);
    this.prune();
    this.schedulePersist();
    return { ...entry };
  }

  noteSpawn(input: {
    scope: string;
    runId: string;
    pid?: number;
    startedAt: number;
  }): string {
    const existing = [...this.entries].reverse().find((entry) => (
      entry.scope === input.scope
      && (entry.status === 'queued' || (entry.status === 'running' && entry.childPid === undefined))
    ));
    if (existing) {
      this.patch(existing.turnId, {
        status: 'running',
        runId: input.runId,
        childPid: input.pid,
        childStartedAt: input.startedAt,
      });
      return existing.turnId;
    }
    return input.runId;
  }

  markSettled(turnId: string, outcome: RunOutcome): void {
    this.patch(turnId, { status: 'settled', outcome });
  }

  // Compatibility writers for callers migrated in D02. Delivery policy and
  // item transitions live in Outbox; this journal only commits their changes.
  stageReply(turnId: string, reply: outboxState.StageReply): void {
    this.changeItem(turnId, (entry) => outboxState.stageReply(entry, reply));
  }

  replyDelivered(turnId: string, messageId?: string): void {
    if (messageId?.trim()) this.noteReplyReceipt(turnId, messageId);
    this.changeItem(turnId, outboxState.replyDelivered);
  }

  replyRejected(turnId: string): void { this.changeItem(turnId, outboxState.replyRejected); }

  noteReplyReceipt(turnId: string, messageId: string, interactive?: boolean): void {
    this.changeItem(turnId, (entry) => outboxState.noteReplyReceipt(entry, messageId, interactive));
  }

  noteCliAlreadySent(turnId: string): void {
    this.patch(turnId, { cliAlreadySent: true });
  }

  noteNonAnswerId(turnId: string, messageId: string): void {
    const id = messageId.trim();
    if (!id) return;
    const entry = this.entries.find((item) => item.turnId === turnId);
    if (!entry) return;
    const existing = entry.nonAnswerIds ?? [];
    if (existing.includes(id)) return;
    this.patch(turnId, { nonAnswerIds: [...existing, id] });
  }

  noteCliAlreadySentForScope(scope: string, turnId: string): void {
    const entry = this.entries.find((item) => item.turnId === turnId);
    if (!entry || entry.scope !== scope) return;
    this.noteCliAlreadySent(turnId);
  }

  markInterrupted(turnId: string, outcome: RunOutcome, consecutiveInterrupts?: number): void {
    const current = this.entries.find((entry) => entry.turnId === turnId);
    this.patch(turnId, {
      status: 'interrupted',
      outcome,
      consecutiveInterrupts: consecutiveInterrupts ?? (current?.consecutiveInterrupts ?? 0) + 1,
    });
  }

  stageNotice(turnId: string, notice: TurnNotice): void {
    this.changeItem(turnId, (entry) => outboxState.stageNotice(entry, notice));
  }

  noticeRejected(turnId: string): void { this.changeItem(turnId, outboxState.noticeRejected); }

  noticeDelivered(turnId: string): void { this.changeItem(turnId, outboxState.noticeDelivered); }

  recordNotice(turnId: string, notice: TurnNotice): void {
    this.patch(turnId, { notice });
  }

  voidTurn(turnId: string): void {
    const current = this.entries.find((item) => item.turnId === turnId);
    this.patch(turnId, {
      status: 'voided',
      ...(current ? outboxState.voidItems(current) : {}),
    });
  }

  noteTurnMeta(turnId: string, fields: { resumeHandle?: string; policyFingerprint?: string }): void {
    this.patch(turnId, fields);
  }

  setContinuation(
    turnId: string,
    status: ContinuationStatus,
    extra?: { consecutiveInterrupts?: number; noticeInvalidated?: boolean },
  ): void {
    const current = this.entries.find((item) => item.turnId === turnId);
    const notice = extra?.noticeInvalidated === true && current ? outboxState.voidNotice(current) : {};
    this.patch(turnId, {
      continuation: { status },
      ...(extra?.consecutiveInterrupts !== undefined
        ? { consecutiveInterrupts: extra.consecutiveInterrupts }
        : {}),
      ...(extra?.noticeInvalidated === true ? { noticeInvalidated: true } : {}),
      ...notice,
    });
  }

  invalidateNotice(turnId: string): void {
    const current = this.entries.find((item) => item.turnId === turnId);
    this.patch(turnId, {
      noticeInvalidated: true,
      ...(current ? outboxState.voidNotice(current) : {}),
    });
  }

  voidScope(scope: string): void {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.scope !== scope) continue;
      if (entry.noticeStatus === 'pending' || entry.noticeStatus === 'delivered' || entry.status === 'notice-pending' || entry.status === 'notice-delivered') {
        if (!entry.noticeInvalidated) {
          entry.noticeInvalidated = true;
          entry.updatedAt = this.now();
          changed = true;
        }
      }
      if (!isIncomplete(entry.status)) continue;
      entry.status = 'voided';
      Object.assign(entry, outboxState.voidItems(entry));
      entry.updatedAt = this.now();
      changed = true;
    }
    if (changed) {
      this.prune();
      this.schedulePersist();
    }
  }

  async reapOrphans(opts: JournalRecoverOptions = {}): Promise<void> {
    await this.reapOrphansOwned(opts);
    await this.flush();
  }

  private async reapOrphansOwned(
    opts: JournalRecoverOptions,
  ): Promise<{ orphans: number; interrupted: number; notices: number }> {
    const snapshot = this.entries.filter((entry) => (
      isRecoverable(entry.status) && !isStagedReply(entry) && !isStagedNotice(entry)
    ));
    if (snapshot.length === 0) return { orphans: 0, interrupted: 0, notices: 0 };

    let orphans = 0;
    let interruptedCount = 0;
    let notices = 0;
    const interrupted: RunOutcome = {
      kind: 'interrupted',
      reason: { type: 'external-signal' },
      retriable: true,
      needsHuman: false,
    };

    for (const entry of snapshot) {
      const current = this.entries.find((item) => item.turnId === entry.turnId);
      if (!current || !isRecoverable(current.status) || isStagedReply(current) || isStagedNotice(current)) continue;

      if (opts.isActive?.(current.scope) && (
        current.status === 'queued' || current.status === 'running' || current.status === 'settled'
      )) {
        continue;
      }

      if (
        current.status === 'queued'
        && current.childPid === undefined
        && this.enqueuedThisProcess.has(current.turnId)
      ) {
        continue;
      }

      if (current.childPid !== undefined && processMatchesIdentity(current.childPid, current.childStartedAt, {
        isAlive: opts.isAlive,
        processStartMs: opts.processStartMs,
      })) {
        await reapOrphan(current.childPid, opts);
        orphans += 1;
      }
      this.markInterrupted(current.turnId, interrupted);
      interruptedCount += 1;
      if (opts.onInterrupted) {
        const updated = this.get(current.turnId);
        if (updated) {
          try {
            const ok = await opts.onInterrupted(updated);
            if (ok) notices += 1;
          } catch (error) {
            log.warn('journal', 'notice-resend-failed', {
              turnId: current.turnId,
              err: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    if (orphans > 0 || interruptedCount > 0 || notices > 0) {
      log.info('journal', 'recovered', {
        orphans,
        resent: 0,
        notices,
        interrupted: interruptedCount,
      });
    }
    return { orphans, interrupted: interruptedCount, notices };
  }

  private changeItem(turnId: string, change: (entry: TurnJournalEntry) => Partial<TurnJournalEntry>): void {
    const entry = this.entries.find((item) => item.turnId === turnId);
    if (entry) this.patch(turnId, change(entry));
  }

  private patch(turnId: string, fields: Partial<TurnJournalEntry>): void {
    const entry = this.entries.find((item) => item.turnId === turnId);
    if (!entry || entry.status === 'voided') return;
    Object.assign(entry, fields, { updatedAt: this.now() });
    this.schedulePersist();
  }

  private async loadDocument(): Promise<void> {
    await this.queue.flush().catch(() => {});
    try {
      let text: string | undefined;
      try {
        text = await readFile(this.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
      if (text === undefined) {
        this.publish(emptyDocument(), false);
        return;
      }
      const document = parseJournalDocument(text);
      // Write the complete upgraded snapshot before publishing it. A failed
      // atomic replacement leaves the original v1 file available for retry.
      if (document.upgrade) {
        await writeFileAtomic(this.path, `${JSON.stringify(serializeDocument(document.entries, document.draftCards), null, 2)}\n`, { mode: 0o600 });
      }
      this.publish(document, false);
      if (this.prune()) this.schedulePersist();
    } catch (error) {
      this.publish(emptyDocument(), true);
      log.warn('journal', 'load-failed', {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private publish(document: JournalDocument, persistenceDisabled: boolean): void {
    this.entries = document.entries;
    this.draftCards = document.draftCards ?? [];
    this.enqueuedThisProcess.clear();
    this.persistenceDisabled = persistenceDisabled;
    this.persistScheduled = false;
    this.persistDirty = false;
    this.queue = new PersistenceQueue();
  }

  private prune(): boolean {
    const cutoff = this.now() - this.maxAgeMs;
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => {
      if (!TERMINAL_PRUNE.has(entry.status)) return true;
      return entry.updatedAt >= cutoff;
    });
    const extra = this.entries.length - this.maxEntries;
    if (extra > 0) {
      const droppable = this.entries
        .map((entry, index) => ({ entry, index }))
        .filter((item) => TERMINAL_PRUNE.has(item.entry.status))
        .sort((a, b) => a.entry.updatedAt - b.entry.updatedAt || a.index - b.index);
      const drop = new Set(droppable.slice(0, extra).map((item) => item.entry.turnId));
      if (drop.size > 0) {
        this.entries = this.entries.filter((entry) => !drop.has(entry.turnId));
      }
    }
    return this.entries.length !== before;
  }

  private schedulePersist(): void {
    if (this.persistenceDisabled) return;
    try {
      this.queue.assertHealthy();
    } catch {
      return;
    }
    this.persistDirty = true;
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    this.queue.enqueue(async () => {
      try {
        while (this.persistDirty) {
          this.persistDirty = false;
          const snapshot = `${JSON.stringify(this.serialize(), null, 2)}\n`;
          try {
            await writeFileAtomic(this.path, snapshot, { mode: 0o600 });
          } catch (error) {
            log.warn('journal', 'persist-failed', {
              err: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        }
      } finally {
        this.persistScheduled = false;
      }
      if (this.persistDirty) this.schedulePersist();
    });
  }

  private serialize(): ReturnType<typeof serializeDocument> {
    return serializeDocument(this.entries, this.draftCards);
  }
}

function emptyDocument(): JournalDocument {
  return { entries: [] };
}

interface StoredOutboxItem {
  kind: 'reply' | 'notice' | 'reminder' | 'result';
  turnId: string;
  deliveryId: string;
  target: { chatId: string; replyTo?: string; replyInThread?: boolean; threadId?: string };
  payload: Record<string, unknown>;
  state: OutboxItemState;
  receipt?: { messageId: string; interactive?: boolean };
  supersedes?: string;
}

function serializeDocument(entries: TurnJournalEntry[], draftCards: DraftCardItem[] = []) {
  const items: Record<string, StoredOutboxItem | DraftCardItem> = Object.create(null);
  for (const item of draftCards) {
    if (items[item.deliveryId]) throw new Error('Duplicate Outbox deliveryId');
    items[item.deliveryId] = structuredClone(item);
  }
  const turns = entries.map((entry) => {
    const { reply, notice, ...turn } = entry;
    const replyId = reply ? reply.deliveryId ?? replyDeliveryKey(entry.turnId) : undefined;
    const noticeId = notice ? notice.deliveryId ?? noticeDeliveryKey(entry.turnId) : undefined;
    if (reply && replyId) {
      const { deliveryId: _id, state: _state, messageId, interactive, supersedes,
        replyTo, replyInThread, threadId, ...payload } = reply;
      if (items[replyId]) throw new Error('Duplicate Outbox deliveryId');
      items[replyId] = {
        kind: reply.kind ?? 'reply', turnId: entry.turnId, deliveryId: replyId,
        target: { chatId: entry.chatId, replyTo, ...(replyInThread ? { replyInThread } : {}), ...(threadId ? { threadId } : {}) },
        payload, state: replyState(entry) ?? 'staged',
        ...(messageId ? { receipt: { messageId, ...(interactive ? { interactive } : {}) } } : {}),
        ...(supersedes ? { supersedes } : {}),
      };
    }
    if (notice && noticeId) {
      const { deliveryId: _id, state: _state, messageId, recipientChatId, replyTo, replyInThread, ...payload } = notice;
      if (items[noticeId]) throw new Error('Duplicate Outbox deliveryId');
      items[noticeId] = {
        kind: 'notice', turnId: entry.turnId, deliveryId: noticeId,
        target: { chatId: recipientChatId, ...(replyTo ? { replyTo } : {}), ...(replyInThread ? { replyInThread } : {}) },
        payload, state: noticeState(entry) ?? 'staged',
        ...(messageId ? { receipt: { messageId } } : {}),
      };
    }
    return { ...turn, ...(replyId ? { replyDeliveryId: replyId } : {}), ...(noticeId ? { noticeDeliveryId: noticeId } : {}) };
  });
  return { schemaVersion: TURN_JOURNAL_SCHEMA_VERSION, entries: turns, items };
}

function parseJournalDocument(text: string): JournalDocument {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw)) throw new Error('Invalid turn journal: expected object');
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== TURN_JOURNAL_SCHEMA_VERSION) {
    throw new Error(`Unsupported turn journal schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (!Array.isArray(raw.entries)) throw new Error('Invalid turn journal entries');
  const upgrade = raw.schemaVersion === 1;
  if (!upgrade && !isObject(raw.items)) throw new Error('Invalid Outbox items');
  const entries: TurnJournalEntry[] = [];
  const referenced = new Set<string>();
  const draftCards: DraftCardItem[] = [];
  if (!upgrade && isObject(raw.items)) {
    for (const [id, item] of Object.entries(raw.items)) {
      if (isObject(item) && item.kind === 'draft-card') {
        draftCards.push(parseDraftCardItem(item, id));
        referenced.add(id);
      }
    }
  }
  for (const item of raw.entries) {
    let materialized = item;
    if (!upgrade && isObject(item)) {
      materialized = { ...item };
      for (const kind of ['reply', 'notice'] as const) {
        const id = item[`${kind}DeliveryId`];
        if (id === undefined) continue;
        if (typeof id !== 'string' || referenced.has(id)) throw new Error('Invalid Outbox reference');
        const stored = isObject(raw.items) ? raw.items[id] : undefined;
        if (!isObject(stored) || !(stored.kind === kind || (kind === 'reply' && (stored.kind === 'reminder' || stored.kind === 'result'))) || stored.deliveryId !== id || stored.turnId !== item.turnId
          || !isObject(stored.target) || !isObject(stored.payload) || !isOutboxItemState(stored.state)) {
          throw new Error('Invalid Outbox item');
        }
        const target = stored.target;
        const receipt = isObject(stored.receipt) ? stored.receipt : {};
        const payload = {
          ...stored.payload, deliveryId: id, state: stored.state,
          ...(stored.kind === 'reminder' || stored.kind === 'result' ? { kind: stored.kind } : {}),
          ...(kind === 'notice' ? { recipientChatId: target.chatId } : {}),
          replyTo: target.replyTo, replyInThread: target.replyInThread, threadId: target.threadId,
          messageId: receipt.messageId, interactive: receipt.interactive, supersedes: stored.supersedes,
        };
        if (!(kind === 'reply' ? parseReply(payload) : parseNotice(payload))) throw new Error('Invalid Outbox payload');
        (materialized as Record<string, unknown>)[kind] = payload;
        referenced.add(id);
      }
    }
    const entry = parseEntry(materialized);
    if (entry) {
      if (entry.reply) entry.reply = { ...entry.reply, deliveryId: entry.reply.deliveryId ?? replyDeliveryKey(entry.turnId), state: replyState(entry) ?? 'staged' };
      if (entry.notice) entry.notice = { ...entry.notice, deliveryId: entry.notice.deliveryId ?? noticeDeliveryKey(entry.turnId), state: noticeState(entry) ?? 'staged' };
      entries.push(entry);
    }
  }
  if (!upgrade && isObject(raw.items) && Object.keys(raw.items).some((id) => !referenced.has(id))) {
    throw new Error('Unreferenced Outbox item');
  }
  return { entries, draftCards, ...(upgrade ? { upgrade: true } : {}) };
}

function parseEntry(raw: unknown): TurnJournalEntry | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.turnId !== 'string' || !raw.turnId) return undefined;
  if (typeof raw.scope !== 'string' || !raw.scope) return undefined;
  if (typeof raw.chatId !== 'string' || !raw.chatId) return undefined;
  if (!isStatus(raw.status)) return undefined;
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return undefined;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return undefined;
  const messageIds = Array.isArray(raw.messageIds)
    ? raw.messageIds.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    turnId: raw.turnId,
    scope: raw.scope,
    chatId: raw.chatId,
    ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
    messageIds,
    senderId: typeof raw.senderId === 'string' ? raw.senderId : '',
    initiatorId: typeof raw.initiatorId === 'string' ? raw.initiatorId : '',
    ...(raw.initiatorType === 'user' || raw.initiatorType === 'bot'
      ? { initiatorType: raw.initiatorType }
      : {}),
    ...(typeof raw.resumeHandle === 'string' ? { resumeHandle: raw.resumeHandle } : {}),
    ...(typeof raw.policyFingerprint === 'string' ? { policyFingerprint: raw.policyFingerprint } : {}),
    ...(typeof raw.runId === 'string' ? { runId: raw.runId } : {}),
    ...(typeof raw.childPid === 'number' && Number.isInteger(raw.childPid) ? { childPid: raw.childPid } : {}),
    ...(typeof raw.childStartedAt === 'number' && Number.isFinite(raw.childStartedAt)
      ? { childStartedAt: raw.childStartedAt }
      : {}),
    status: raw.status,
    ...(isObject(raw.outcome) ? { outcome: raw.outcome as RunOutcome } : {}),
    ...(raw.noticeStatus === 'none' || raw.noticeStatus === 'pending' || raw.noticeStatus === 'delivered'
      ? { noticeStatus: raw.noticeStatus }
      : {}),
    ...(raw.noticeInvalidated === true ? { noticeInvalidated: true } : {}),
    ...(parseNotice(raw.notice) ? { notice: parseNotice(raw.notice) } : {}),
    ...(parseContinuation(raw.continuation) ? { continuation: parseContinuation(raw.continuation) } : {}),
    ...(typeof raw.consecutiveInterrupts === 'number' && Number.isFinite(raw.consecutiveInterrupts)
      ? { consecutiveInterrupts: raw.consecutiveInterrupts }
      : {}),
    ...(typeof raw.userInput === 'string' ? { userInput: raw.userInput } : {}),
    ...(parseResources(raw.resources) ? { resources: parseResources(raw.resources) } : {}),
    ...(parseReply(raw.reply) ? { reply: parseReply(raw.reply) } : {}),
    ...(raw.cliAlreadySent === true ? { cliAlreadySent: true } : {}),
    ...(parseIdList(raw.nonAnswerIds) ? { nonAnswerIds: parseIdList(raw.nonAnswerIds) } : {}),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function parseIdList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length > 0 ? ids : undefined;
}

function parseContinuation(raw: unknown): TurnContinuation | undefined {
  if (!isObject(raw)) return undefined;
  switch (raw.status) {
    case 'offered':
    case 'continue-requested':
    case 'continued':
    case 'abandoned':
    case 'voided':
    case 'dismissed':
      return { status: raw.status };
    default:
      return undefined;
  }
}

function parseNotice(raw: unknown): TurnNotice | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.kind !== 'continue' && raw.kind !== 'plain' && raw.kind !== 'auth') return undefined;
  if (typeof raw.recipientChatId !== 'string' || typeof raw.markdown !== 'string') return undefined;
  return {
    kind: raw.kind,
    recipientChatId: raw.recipientChatId,
    markdown: raw.markdown,
    ...(typeof raw.replyTo === 'string' ? { replyTo: raw.replyTo } : {}),
    ...(raw.replyInThread === true ? { replyInThread: true } : {}),
    ...(raw.includeButtons === true ? { includeButtons: true } : {}),
    ...(typeof raw.ownerChatId === 'string' ? { ownerChatId: raw.ownerChatId } : {}),
    ...(raw.initiatorDelivered === true ? { initiatorDelivered: true } : {}),
    ...(raw.ownerDelivered === true ? { ownerDelivered: true } : {}),
    ...(typeof raw.continueHint === 'string' ? { continueHint: raw.continueHint } : {}),
    ...(typeof raw.messageId === 'string' && raw.messageId ? { messageId: raw.messageId } : {}),
    ...(typeof raw.deliveryId === 'string' && raw.deliveryId ? { deliveryId: raw.deliveryId } : {}),
    ...(isOutboxItemState(raw.state) ? { state: raw.state } : {}),
  };
}

function parseResources(raw: unknown): TurnJournalResource[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const resources: TurnJournalResource[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    if (!isJournalResourceType(item.type) || typeof item.fileKey !== 'string') continue;
    if (typeof item.sourceMessageId !== 'string' || !item.sourceMessageId) continue;
    resources.push({
      type: item.type,
      fileKey: item.fileKey,
      sourceMessageId: item.sourceMessageId,
    });
  }
  return resources.length > 0 ? resources : undefined;
}

export function isJournalResourceType(value: unknown): value is TurnJournalResourceType {
  return typeof value === 'string'
    && (TURN_JOURNAL_RESOURCE_TYPES as readonly string[]).includes(value);
}

function parseReply(raw: unknown): TurnReply | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.markdown !== 'string' || typeof raw.replyTo !== 'string') return undefined;
  if (typeof raw.replyMode !== 'string') return undefined;
  return {
    markdown: raw.markdown,
    ...(raw.kind === 'reminder' || raw.kind === 'result' ? { kind: raw.kind } : {}),
    replyTo: raw.replyTo,
    replyMode: raw.replyMode,
    ...(raw.replyInThread === true ? { replyInThread: true } : {}),
    ...(typeof raw.threadId === 'string' && raw.threadId ? { threadId: raw.threadId } : {}),
    ...(typeof raw.deliveryId === 'string' && raw.deliveryId ? { deliveryId: raw.deliveryId } : {}),
    ...(typeof raw.messageId === 'string' && raw.messageId ? { messageId: raw.messageId } : {}),
    ...(raw.interactive === true ? { interactive: true } : {}),
    ...(typeof raw.supersedes === 'string' && raw.supersedes ? { supersedes: raw.supersedes } : {}),
    ...(isOutboxItemState(raw.state) ? { state: raw.state } : {}),
  };
}

function isStatus(value: unknown): value is TurnJournalStatus {
  switch (value) {
    case 'queued':
    case 'running':
    case 'settled':
    case 'reply-delivered':
    case 'completed-undelivered':
    case 'interrupted':
    case 'notice-pending':
    case 'notice-delivered':
    case 'voided':
      return true;
    default:
      return false;
  }
}

function isIncomplete(status: TurnJournalStatus): boolean {
  switch (status) {
    case 'queued':
    case 'running':
    case 'settled':
    case 'completed-undelivered':
    case 'interrupted':
    case 'notice-pending':
      return true;
    case 'reply-delivered':
    case 'notice-delivered':
    case 'voided':
      return false;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function isOutboxItemState(value: unknown): value is OutboxItemState {
  switch (value) {
    case 'staged':
    case 'sent':
    case 'rejected':
    case 'voided':
      return true;
    default:
      return false;
  }
}

function isStagedReply(entry: TurnJournalEntry): boolean {
  return replyState(entry) === 'staged';
}

function isStagedNotice(entry: TurnJournalEntry): boolean {
  return noticeState(entry) === 'staged';
}

function isRecoverable(status: TurnJournalStatus): boolean {
  switch (status) {
    case 'queued':
    case 'running':
    case 'settled':
    case 'completed-undelivered':
      return true;
    case 'interrupted':
    case 'reply-delivered':
    case 'notice-delivered':
    case 'voided':
      return false;
    case 'notice-pending':
      return true;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

async function reapOrphan(pid: number, opts: JournalRecoverOptions): Promise<void> {
  const kill = opts.kill ?? defaultKill;
  const graceMs = opts.orphanGraceMs ?? TURN_JOURNAL_ORPHAN_GRACE_MS;
  signalPid(kill, pid, 'SIGTERM');
  if (graceMs > 0) await sleep(graceMs);
  signalPid(kill, pid, 'SIGKILL');
}

function signalPid(
  kill: (pid: number, signal: NodeJS.Signals) => void,
  pid: number,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== 'win32') {
    try {
      kill(-pid, signal);
      return;
    } catch {
      // Process is not a group leader; fall through to the pid.
    }
  }
  try {
    kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function sleep(ms: number): Promise<void> {
  return defaultSleep(ms);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { readProcessStartMs, isProcessAlive };
