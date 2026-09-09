import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { PersistenceQueue } from '../platform/persistence-queue';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { isAgentKind, type AgentKind } from '../agent/registry';
import {
  CATALOG_SCHEMA_VERSION,
  upgradeCatalogDocument,
  type CatalogEntryV2,
} from './migrations';

export type CatalogAgentId = AgentKind;
export type SessionCatalogStatus = 'active' | 'archived';

export interface SessionCatalogIdentity {
  scopeId: string;
  agentId: CatalogAgentId;
  cwdRealpath: string;
  policyFingerprint: string;
}

export type SessionCatalogEntry = CatalogEntryV2;

export interface UpsertSessionCatalogInput extends SessionCatalogIdentity {
  now?: number;
  resumeHandle: string;
  lastSummary?: string;
}

export interface ArchiveSessionCatalogInput extends SessionCatalogIdentity {
  now?: number;
}

export interface SessionCatalogGcOptions {
  now?: number;
  maxArchivedAgeMs?: number;
  maxEntriesPerScope?: number;
  maxEntriesPerProfile?: number;
}

const DEFAULT_MAX_ARCHIVED_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 20;
const DEFAULT_MAX_ENTRIES_PER_PROFILE = 1000;
const KEY_SEPARATOR = '\x1f';

export function sessionCatalogKey(input: SessionCatalogIdentity): string {
  return [
    input.scopeId,
    input.agentId,
    input.cwdRealpath,
    input.policyFingerprint,
  ].join(KEY_SEPARATOR);
}

export class SessionCatalog {
  private data = new Map<string, SessionCatalogEntry>();
  private queue = new PersistenceQueue();
  private loadFailure: { error: unknown } | undefined;
  private loading: Promise<void> | undefined;
  private readonly path: string;

  constructor(path = `${paths.sessionsFile}.catalog.json`) {
    this.path = path;
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.loadDocument().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async loadDocument(): Promise<void> {
    // Reload is the recovery boundary. Drain the old writer before reading;
    // mutations remain blocked until a complete document has been published.
    await this.queue.flush().catch(() => {});
    try {
      let text: string | undefined;
      try {
        text = await readFile(this.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
      const { document, upgraded } = text === undefined
        ? { document: { schemaVersion: CATALOG_SCHEMA_VERSION, entries: [] }, upgraded: false }
        : upgradeCatalogDocument(JSON.parse(text));
      if (upgraded) {
        await writeFileAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      }
      this.data = new Map(document.entries.map(entry => [entry.key, { ...entry }]));
      this.queue = new PersistenceQueue();
      this.loadFailure = undefined;
    } catch (error) {
      this.loadFailure = { error };
      log.fail('session-catalog', error, { step: 'load' });
      throw error;
    }
  }

  activeFor(input: SessionCatalogIdentity): SessionCatalogEntry | undefined {
    const entry = this.data.get(sessionCatalogKey(input));
    if (!entry || entry.status !== 'active') return undefined;
    if (!matchesIdentity(entry, input)) return undefined;
    if (!isValidAgentEntry(entry)) {
      log.warn('session-catalog', 'damaged-entry', {
        key: entry.key,
        agentId: entry.agentId,
      });
      return undefined;
    }
    return { ...entry };
  }

  upsertActive(input: UpsertSessionCatalogInput): SessionCatalogEntry {
    this.assertMutable();
    assertAgentIdentity(input);
    const key = sessionCatalogKey(input);
    const entry: SessionCatalogEntry = {
      key,
      scopeId: input.scopeId,
      agentId: input.agentId,
      cwdRealpath: input.cwdRealpath,
      policyFingerprint: input.policyFingerprint,
      status: 'active',
      updatedAt: input.now ?? Date.now(),
      resumeHandle: input.resumeHandle,
      ...(input.lastSummary ? { lastSummary: input.lastSummary } : {}),
    };
    this.data.set(key, entry);
    this.schedulePersist();
    return { ...entry };
  }

  archiveActive(input: ArchiveSessionCatalogInput): boolean {
    this.assertMutable();
    const key = sessionCatalogKey(input);
    const entry = this.data.get(key);
    if (!entry || entry.status !== 'active') return false;
    this.data.set(key, {
      ...entry,
      status: 'archived',
      updatedAt: input.now ?? Date.now(),
    });
    this.schedulePersist();
    return true;
  }

  entries(): SessionCatalogEntry[] {
    return [...this.data.values()].map((entry) => ({ ...entry }));
  }

  gc(options: SessionCatalogGcOptions = {}): void {
    this.assertMutable();
    const now = options.now ?? Date.now();
    const maxArchivedAgeMs = options.maxArchivedAgeMs ?? DEFAULT_MAX_ARCHIVED_AGE_MS;
    const maxEntriesPerScope = options.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE;
    const maxEntriesPerProfile =
      options.maxEntriesPerProfile ?? DEFAULT_MAX_ENTRIES_PER_PROFILE;

    for (const [key, entry] of this.data.entries()) {
      if (entry.status === 'archived' && now - entry.updatedAt > maxArchivedAgeMs) {
        this.data.delete(key);
      }
    }

    for (const scopeId of new Set([...this.data.values()].map((entry) => entry.scopeId))) {
      const scoped = [...this.data.values()]
        .filter((entry) => entry.scopeId === scopeId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      for (const entry of scoped.slice(maxEntriesPerScope)) {
        this.data.delete(entry.key);
      }
    }

    const all = [...this.data.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const entry of all.slice(maxEntriesPerProfile)) {
      this.data.delete(entry.key);
    }
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    if (this.loading) await this.loading;
    if (this.loadFailure) throw this.loadFailure.error;
    await this.queue.flush();
  }

  async replaceForTest(entries: SessionCatalogEntry[]): Promise<void> {
    this.assertMutable();
    this.data = new Map(entries.map(entry => [entry.key, { ...entry }]));
    this.schedulePersist();
    await this.flush();
  }

  private assertMutable(): void {
    if (this.loadFailure) throw this.loadFailure.error;
    if (this.loading) throw new Error('Session catalog is loading');
    this.queue.assertHealthy();
  }

  private schedulePersist(): void {
    const snapshot = `${JSON.stringify(
      { schemaVersion: CATALOG_SCHEMA_VERSION, entries: this.entries() }, null, 2,
    )}\n`;
    this.queue.enqueue(() => writeFileAtomic(this.path, snapshot, { mode: 0o600 }));
  }
}

function matchesIdentity(entry: SessionCatalogEntry, input: SessionCatalogIdentity): boolean {
  return (
    entry.scopeId === input.scopeId &&
    entry.agentId === input.agentId &&
    entry.cwdRealpath === input.cwdRealpath &&
    entry.policyFingerprint === input.policyFingerprint &&
    entry.key === sessionCatalogKey(input)
  );
}

function isValidAgentEntry(entry: SessionCatalogEntry): boolean {
  return Boolean(entry.resumeHandle) && isAgentKind(entry.agentId);
}

function assertAgentIdentity(input: UpsertSessionCatalogInput): void {
  if (!input.resumeHandle) {
    throw new Error('catalog entries require resumeHandle');
  }
}
