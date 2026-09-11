import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { PersistenceQueue } from '../platform/persistence-queue';
import { log } from '../core/logger';

/** Spec default lookback; ticket 06 makes this configurable. */
export const BACKFILL_LOOKBACK_MS = 6 * 60 * 60 * 1000;
export const BACKFILL_LEDGER_MAX_IDS = 5000;
export const BACKFILL_LEDGER_SCHEMA_VERSION = 1 as const;

export type IntakeSource = 'ws' | 'backfill';

export interface BackfillLedgerOptions {
  now?: () => number;
}

interface LedgerDocument {
  processed: Map<string, number>;
  lastLiveAt?: number;
  lastBackfillEnd?: number;
}

export class BackfillLedger {
  private readonly path: string;
  private readonly now: () => number;
  private processed = new Map<string, number>();
  private readonly claimed = new Set<string>();
  private lastLiveAt: number | undefined;
  private lastBackfillEnd: number | undefined;
  private queue = new PersistenceQueue();
  private loading: Promise<void> | undefined;
  private persistenceDisabled = false;

  constructor(path: string, opts: BackfillLedgerOptions = {}) {
    this.path = path;
    this.now = opts.now ?? Date.now;
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
    this.persistenceDisabled = persistenceDisabled;
    this.queue = new PersistenceQueue();
  }

  private prune(): boolean {
    const cutoff = this.now() - 2 * BACKFILL_LOOKBACK_MS;
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
    const snapshot = `${JSON.stringify(this.serialize(), null, 2)}\n`;
    this.queue.enqueue(async () => {
      try {
        await writeFileAtomic(this.path, snapshot, { mode: 0o600 });
      } catch (error) {
        log.warn('backfill', 'ledger-persist-failed', {
          err: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  private serialize(): {
    schemaVersion: typeof BACKFILL_LEDGER_SCHEMA_VERSION;
    lastLiveAt?: number;
    lastBackfillEnd?: number;
    processed: Record<string, number>;
  } {
    return {
      schemaVersion: BACKFILL_LEDGER_SCHEMA_VERSION,
      ...(this.lastLiveAt !== undefined ? { lastLiveAt: this.lastLiveAt } : {}),
      ...(this.lastBackfillEnd !== undefined ? { lastBackfillEnd: this.lastBackfillEnd } : {}),
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
  };
}

function optionalTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
