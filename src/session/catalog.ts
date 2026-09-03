import { randomUUID } from 'node:crypto';
import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { isAgentKind, type AgentKind } from '../agent/registry';
import {
  CATALOG_SCHEMA_VERSION,
  UnsupportedCatalogSchemaError,
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
  private saving: Promise<void> = Promise.resolve();
  private persistFrozen = false;
  private readonly path: string;

  constructor(path = `${paths.sessionsFile}.catalog.json`) {
    this.path = path;
  }

  async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.fail('session-catalog', err, { step: 'load' });
      this.data.clear();
      return;
    }

    let document: { entries: SessionCatalogEntry[] };
    let upgraded: boolean;
    try {
      ({ document, upgraded } = upgradeCatalogDocument(raw));
    } catch (err) {
      log.fail('session-catalog', err, { step: 'load' });
      if (err instanceof UnsupportedCatalogSchemaError) {
        this.persistFrozen = true;
        return;
      }
      this.data.clear();
      return;
    }

    this.persistFrozen = false;
    this.data = new Map(document.entries.map((entry) => [entry.key, { ...entry }]));
    if (!upgraded) return;
    try {
      await this.persist();
    } catch (err) {
      log.fail('session-catalog', err, { step: 'persist' });
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
    await this.saving;
  }

  async replaceForTest(entries: SessionCatalogEntry[]): Promise<void> {
    await this.saving;
    this.data = new Map(entries.map((entry) => [entry.key, { ...entry }]));
    await this.persist();
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(() => this.persist())
      .catch((err: unknown) => {
        log.fail('session-catalog', err, { step: 'persist' });
      });
  }

  private async persist(): Promise<void> {
    if (this.persistFrozen) {
      log.warn('session-catalog', 'persist-skipped', { reason: 'unsupported-schema' });
      return;
    }
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(
      { schemaVersion: CATALOG_SCHEMA_VERSION, entries: this.entries() },
      null,
      2,
    )}\n`;
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(payload, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.path);
    try {
      const dir = await open(dirname(this.path), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // Directory fsync is not available on every platform.
    }
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
