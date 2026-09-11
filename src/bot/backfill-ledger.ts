import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { PersistenceQueue } from '../platform/persistence-queue';
import { DEFAULT_BACKFILL_PREFERENCES } from '../config/schema';
import { log } from '../core/logger';

export const BACKFILL_LOOKBACK_MS = DEFAULT_BACKFILL_PREFERENCES.lookbackMs;
export const BACKFILL_LEDGER_MAX_IDS = 5000;
export const BACKFILL_LEDGER_SCHEMA_VERSION = 1 as const;
export const LIVE_WATERMARK_THROTTLE_MS = 30_000;

export type IntakeSource = 'ws' | 'backfill';

export interface BackfillLedgerOptions {
  now?: () => number;
  /** Defaults to `2 ×` the spec lookback. Supervisor passes the live config getter. */
  pruneHorizonMs?: () => number;
}

interface LedgerDocument {
  processed: Map<string, number>;
  lastLiveAt?: number;
  lastBackfillEnd?: number;
  incompleteFrom?: number;
}

export class BackfillLedger {
  private readonly path: string;
  private readonly now: () => number;
  private readonly pruneHorizonMs: () => number;
  private processed = new Map<string, number>();
  private readonly claimed = new Set<string>();
  private lastLiveAt: number | undefined;
  private lastBackfillEnd: number | undefined;
  private incompleteFrom: number | undefined;
  private lastLivePersistAt: number | undefined;
  private clockSkewWarned = false;
  private queue = new PersistenceQueue();
  private persistScheduled = false;
  private persistDirty = false;
  private loading: Promise<void> | undefined;
  private persistenceDisabled = false;

  constructor(path: string, opts: BackfillLedgerOptions = {}) {
    this.path = path;
    this.now = opts.now ?? Date.now;
    this.pruneHorizonMs = opts.pruneHorizonMs ?? (() => 2 * BACKFILL_LOOKBACK_MS);
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

  has(messageId: string): boolean {
    return this.processed.has(messageId);
  }

  claim(messageId: string): boolean {
    if (this.processed.has(messageId) || this.claimed.has(messageId)) return false;
    this.claimed.add(messageId);
    return true;
  }

  release(messageId: string): void {
    this.claimed.delete(messageId);
  }

  record(messageId: string, createTimeMs: number): void {
    this.claimed.delete(messageId);
    if (this.processed.has(messageId)) return;
    const createTime = Number.isFinite(createTimeMs) ? createTimeMs : this.now();
    this.processed.set(messageId, createTime);
    this.prune();
    this.schedulePersist();
  }

  touchLive(now: number): void {
    if (!Number.isFinite(now)) return;
    const previous = this.lastLiveAt;
    if (previous !== undefined && now < previous) {
      this.lastLiveAt = now;
      if (!this.clockSkewWarned) {
        this.clockSkewWarned = true;
        log.warn('backfill', 'clock-skew', { lastLiveAt: previous, now });
      }
      this.lastLivePersistAt = now;
      this.schedulePersist();
      return;
    }
    if (previous === now) return;
    this.lastLiveAt = now;
    if (
      this.lastLivePersistAt !== undefined
      && now - this.lastLivePersistAt < LIVE_WATERMARK_THROTTLE_MS
    ) {
      return;
    }
    this.lastLivePersistAt = now;
    this.schedulePersist();
  }

  getLiveAt(): number | undefined {
    return this.lastLiveAt;
  }

  getLastBackfillEnd(): number | undefined {
    return this.lastBackfillEnd;
  }

  getIncompleteFrom(): number | undefined {
    return this.incompleteFrom;
  }

  markScanIncomplete(anchor: number): void {
    if (!Number.isFinite(anchor)) return;
    this.incompleteFrom = this.incompleteFrom === undefined
      ? anchor
      : Math.min(this.incompleteFrom, anchor);
    this.schedulePersist();
  }

  markScanComplete(windowEnd: number, now: number): void {
    if (!Number.isFinite(windowEnd) || !Number.isFinite(now)) return;
    this.lastBackfillEnd = windowEnd;
    this.lastLiveAt = now;
    this.lastLivePersistAt = now;
    this.incompleteFrom = undefined;
    this.prune();
    this.schedulePersist();
  }

  getProcessedCount(): number {
    return this.processed.size;
  }

  getFilePath(): string {
    return this.path;
  }

  private async loadDocument(): Promise<void> {
    await this.queue.flush().catch(() => {});
    this.claimed.clear();
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
      const document = parseLedgerDocument(text);
      this.publish(document, false);
      if (this.prune()) this.schedulePersist();
    } catch (error) {
      this.publish(emptyDocument(), true);
      log.warn('backfill', 'ledger-load-failed', {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private publish(document: LedgerDocument, persistenceDisabled: boolean): void {
    this.processed = document.processed;
    this.lastLiveAt = document.lastLiveAt;
    this.lastBackfillEnd = document.lastBackfillEnd;
    this.incompleteFrom = document.incompleteFrom;
    this.lastLivePersistAt = document.lastLiveAt;
    this.clockSkewWarned = false;
    this.persistenceDisabled = persistenceDisabled;
    this.persistScheduled = false;
    this.persistDirty = false;
    this.queue = new PersistenceQueue();
  }

  private prune(): boolean {
    const cutoff = this.now() - this.pruneHorizonMs();
    const before = this.processed.size;
    for (const [messageId, createTime] of this.processed) {
      if (createTime < cutoff) this.processed.delete(messageId);
    }
    if (this.processed.size > BACKFILL_LEDGER_MAX_IDS) {
      const oldest = [...this.processed.entries()].sort((a, b) => (
        a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      ));
      const drop = this.processed.size - BACKFILL_LEDGER_MAX_IDS;
      for (let i = 0; i < drop; i++) this.processed.delete(oldest[i]![0]);
    }
    return this.processed.size !== before;
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
            log.warn('backfill', 'ledger-persist-failed', {
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
    schemaVersion: typeof BACKFILL_LEDGER_SCHEMA_VERSION;
    lastLiveAt?: number;
    lastBackfillEnd?: number;
    incompleteFrom?: number;
    processed: Record<string, number>;
  } {
    return {
      schemaVersion: BACKFILL_LEDGER_SCHEMA_VERSION,
      ...(this.lastLiveAt !== undefined ? { lastLiveAt: this.lastLiveAt } : {}),
      ...(this.lastBackfillEnd !== undefined ? { lastBackfillEnd: this.lastBackfillEnd } : {}),
      ...(this.incompleteFrom !== undefined ? { incompleteFrom: this.incompleteFrom } : {}),
      processed: Object.fromEntries(this.processed),
    };
  }
}

function emptyDocument(): LedgerDocument {
  return { processed: new Map() };
}

function parseLedgerDocument(text: string): LedgerDocument {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw)) throw new Error('Invalid backfill ledger: expected object');
  if (raw.schemaVersion !== BACKFILL_LEDGER_SCHEMA_VERSION) {
    throw new Error(`Unsupported backfill ledger schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (raw.processed !== undefined && !isObject(raw.processed)) {
    throw new Error('Invalid backfill ledger processed map');
  }
  const processed = new Map<string, number>();
  if (isObject(raw.processed)) {
    for (const [messageId, value] of Object.entries(raw.processed)) {
      if (typeof value === 'number' && Number.isFinite(value)) processed.set(messageId, value);
    }
  }
  return {
    processed,
    lastLiveAt: optionalTime(raw.lastLiveAt),
    lastBackfillEnd: optionalTime(raw.lastBackfillEnd),
    incompleteFrom: optionalTime(raw.incompleteFrom),
  };
}

function optionalTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatSelfHealLine(input: {
  path?: string;
  lastLiveAt?: number;
  processedCount?: number;
  now: number;
}): string {
  const lastLiveAt = input.lastLiveAt === undefined
    ? 'not yet recorded'
    : formatWatermarkAge(input.now - input.lastLiveAt);
  return `self-heal: ledger=${input.path ?? 'unavailable'} lastLiveAt=${lastLiveAt} processed=${input.processedCount ?? 0}`;
}

function formatWatermarkAge(ageMs: number): string {
  const ms = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
