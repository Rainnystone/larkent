import { readFile } from 'node:fs/promises';
import type { RunOutcome } from './run-outcome';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import { PersistenceQueue } from '../platform/persistence-queue';
import {
  isProcessAlive,
  processMatchesIdentity,
  readProcessStartMs,
} from '../platform/process-info';

export const TURN_JOURNAL_SCHEMA_VERSION = 1 as const;
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

export interface TurnReply {
  markdown: string;
  replyTo: string;
  replyInThread?: boolean;
  replyMode: string;
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
}

export interface TurnJournalEntry {
  turnId: string;
  scope: string;
  chatId: string;
  threadId?: string;
  messageIds: string[];
  senderId: string;
  initiatorId: string;
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
  consecutiveInterrupts?: number;
  userInput?: string;
  resources?: TurnJournalResource[];
  reply?: TurnReply;
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
  enabled: boolean;
  resend?: (entry: TurnJournalEntry) => Promise<boolean>;
  resendNotice?: (entry: TurnJournalEntry) => Promise<boolean>;
  noticeGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  processStartMs?: (pid: number) => number | undefined;
  orphanGraceMs?: number;
  /** Live scopes owned by this process; skip orphan reaping for those entries. */
  isActive?: (scope: string) => boolean;
}

interface JournalDocument {
  entries: TurnJournalEntry[];
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
  private queue = new PersistenceQueue();
  private persistScheduled = false;
  private persistDirty = false;
  private loading: Promise<void> | undefined;
  private persistenceDisabled = false;
  private recovering: Promise<{ orphans: number; resent: number }> | undefined;

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

  enqueue(input: Omit<TurnJournalEntry, 'createdAt' | 'updatedAt'>): TurnJournalEntry {
    const now = this.now();
    const entry: TurnJournalEntry = {
      ...input,
      messageIds: [...input.messageIds],
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
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

  update(turnId: string, fields: Partial<Omit<TurnJournalEntry, 'turnId' | 'createdAt'>>): void {
    this.patch(turnId, fields);
  }

  markSettled(turnId: string, outcome: RunOutcome): void {
    this.patch(turnId, { status: 'settled', outcome });
  }

  markReplyDelivered(turnId: string): void {
    this.patch(turnId, { status: 'reply-delivered' });
  }

  markCompletedUndelivered(turnId: string, reply: TurnReply): void {
    this.patch(turnId, { status: 'completed-undelivered', reply });
  }

  markInterrupted(turnId: string, outcome: RunOutcome, consecutiveInterrupts?: number): void {
    const current = this.entries.find((entry) => entry.turnId === turnId);
    this.patch(turnId, {
      status: 'interrupted',
      outcome,
      consecutiveInterrupts: consecutiveInterrupts ?? (current?.consecutiveInterrupts ?? 0) + 1,
    });
  }

  markNoticePending(turnId: string, notice: TurnNotice): void {
    this.patch(turnId, {
      status: 'notice-pending',
      noticeStatus: 'pending',
      notice,
    });
  }

  markNoticeDelivered(turnId: string): void {
    this.patch(turnId, { status: 'notice-delivered', noticeStatus: 'delivered' });
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
      entry.updatedAt = this.now();
      changed = true;
    }
    if (changed) {
      this.prune();
      this.schedulePersist();
    }
  }

  recover(opts: JournalRecoverOptions): Promise<{ orphans: number; resent: number }> {
    if (this.recovering) return this.recovering;
    this.recovering = this.recoverOwned(opts).finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }

  private async recoverOwned(
    opts: JournalRecoverOptions,
  ): Promise<{ orphans: number; resent: number }> {
    if (!opts.enabled) return { orphans: 0, resent: 0 };
    const snapshot = this.entries.filter((entry) => isRecoverable(entry.status));
    if (snapshot.length === 0) return { orphans: 0, resent: 0 };

    let orphans = 0;
    let resent = 0;
    let notices = 0;
    const pendingNoticeCount = snapshot.filter((item) => item.status === 'notice-pending').length;
    const interrupted: RunOutcome = {
      kind: 'interrupted',
      reason: { type: 'external-signal' },
      retriable: true,
      needsHuman: false,
    };

    for (const entry of snapshot) {
      const current = this.entries.find((item) => item.turnId === entry.turnId);
      if (!current || !isRecoverable(current.status)) continue;

      if (current.status === 'notice-pending') {
        if (opts.isActive?.(current.scope)) continue;
        if (!opts.resendNotice || current.noticeInvalidated) continue;
        try {
          const ok = await opts.resendNotice({ ...current });
          if (ok) {
            this.markNoticeDelivered(current.turnId);
            notices += 1;
            if (opts.noticeGapMs && notices < pendingNoticeCount) {
              await (opts.sleep ?? defaultSleep)(opts.noticeGapMs);
            }
          }
        } catch (error) {
          log.warn('journal', 'notice-resend-failed', {
            turnId: current.turnId,
            err: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }

      if (opts.isActive?.(current.scope) && (
        current.status === 'queued' || current.status === 'running' || current.status === 'settled'
      )) {
        continue;
      }

      if (current.status === 'queued' && current.childPid === undefined) {
        continue;
      }

      if (current.status === 'completed-undelivered' || (current.status === 'settled' && current.reply)) {
        if (!opts.resend || !current.reply) continue;
        try {
          const ok = await opts.resend({ ...current });
          if (ok) {
            this.markReplyDelivered(current.turnId);
            resent += 1;
          }
        } catch (error) {
          log.warn('journal', 'resend-failed', {
            turnId: current.turnId,
            err: error instanceof Error ? error.message : String(error),
          });
        }
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
    }

    if (orphans > 0 || resent > 0 || notices > 0) {
      log.info('journal', 'recovered', { orphans, resent, notices });
    }
    await this.flush();
    return { orphans, resent };
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

  private serialize(): {
    schemaVersion: typeof TURN_JOURNAL_SCHEMA_VERSION;
    entries: TurnJournalEntry[];
  } {
    return {
      schemaVersion: TURN_JOURNAL_SCHEMA_VERSION,
      entries: this.entries.map((entry) => ({ ...entry })),
    };
  }
}

function emptyDocument(): JournalDocument {
  return { entries: [] };
}

function parseJournalDocument(text: string): JournalDocument {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw)) throw new Error('Invalid turn journal: expected object');
  if (raw.schemaVersion !== TURN_JOURNAL_SCHEMA_VERSION) {
    throw new Error(`Unsupported turn journal schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (!Array.isArray(raw.entries)) throw new Error('Invalid turn journal entries');
  const entries: TurnJournalEntry[] = [];
  for (const item of raw.entries) {
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
  }
  return { entries };
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
    ...(typeof raw.consecutiveInterrupts === 'number' && Number.isFinite(raw.consecutiveInterrupts)
      ? { consecutiveInterrupts: raw.consecutiveInterrupts }
      : {}),
    ...(typeof raw.userInput === 'string' ? { userInput: raw.userInput } : {}),
    ...(parseResources(raw.resources) ? { resources: parseResources(raw.resources) } : {}),
    ...(parseReply(raw.reply) ? { reply: parseReply(raw.reply) } : {}),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
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
    replyTo: raw.replyTo,
    replyMode: raw.replyMode,
    ...(raw.replyInThread === true ? { replyInThread: true } : {}),
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
