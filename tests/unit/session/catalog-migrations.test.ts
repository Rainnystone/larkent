import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_SCHEMA_VERSION,
  UnsupportedCatalogSchemaError,
  upgradeCatalogDocument,
} from '../../../src/session/migrations.js';
import { SessionCatalog } from '../../../src/session/catalog.js';

const fixtureRoot = join(process.cwd(), 'tests/fixtures/sessions');
const cleanups: Array<() => Promise<void>> = [];

describe('catalog v1 to v2 upgrade', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('folds Claude sessionId into resumeHandle', () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureRoot, 'catalog-v1-claude.json'), 'utf8'),
    ) as unknown;
    const { document, upgraded } = upgradeCatalogDocument(raw);
    expect(upgraded).toBe(true);
    expect(document.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    expect(document.entries).toHaveLength(1);
    expect(document.entries[0]).toMatchObject({
      agentId: 'claude',
      resumeHandle: 'sess-v1-claude',
    });
    expect(document.entries[0]).not.toHaveProperty('sessionId');
    expect(document.entries[0]).not.toHaveProperty('threadId');
  });

  it('folds Codex threadId into resumeHandle', () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureRoot, 'catalog-v1-codex.json'), 'utf8'),
    ) as unknown;
    const { document, upgraded } = upgradeCatalogDocument(raw);
    expect(upgraded).toBe(true);
    expect(document.entries[0]).toMatchObject({
      agentId: 'codex',
      resumeHandle: 'thread-v1-codex',
    });
    expect(document.entries[0]).not.toHaveProperty('threadId');
    expect(document.entries[0]).not.toHaveProperty('sessionId');
  });

  it('prefers threadId when a v1 entry has both fields', () => {
    const { document } = upgradeCatalogDocument([
      {
        key: 'k',
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp',
        status: 'active',
        updatedAt: 1,
        sessionId: 'sess-wrong',
        threadId: 'thread-right',
      },
    ]);
    expect(document.entries[0]?.resumeHandle).toBe('thread-right');
  });

  it('treats a current-shape document as a no-op', () => {
    const current = {
      schemaVersion: 2 as const,
      entries: [
        {
          key: 'k',
          scopeId: 'chat-1',
          agentId: 'kimi' as const,
          cwdRealpath: '/repo',
          policyFingerprint: 'fp',
          status: 'active' as const,
          updatedAt: 1,
          resumeHandle: 'sess-v2',
        },
      ],
    };
    const first = upgradeCatalogDocument(current);
    expect(first.upgraded).toBe(false);
    const second = upgradeCatalogDocument(first.document);
    expect(second.upgraded).toBe(false);
    expect(second.document).toEqual(first.document);
  });

  it('writes v2 on load and reloads as a no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-migrate-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const dest = join(dir, 'sessions.json.catalog.json');
    await copyFile(join(fixtureRoot, 'catalog-v1-codex.json'), dest);

    const catalog = new SessionCatalog(dest);
    await catalog.load();
    const loaded = catalog.entries();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.resumeHandle).toBe('thread-v1-codex');
    expect(loaded[0]).not.toHaveProperty('threadId');

    const afterUpgrade = JSON.parse(await readFile(dest, 'utf8')) as {
      schemaVersion: number;
      entries: Array<{ resumeHandle?: string; threadId?: string }>;
    };
    expect(afterUpgrade.schemaVersion).toBe(2);
    expect(afterUpgrade.entries[0]?.resumeHandle).toBe('thread-v1-codex');
    expect(afterUpgrade.entries[0]?.threadId).toBeUndefined();

    await catalog.load();
    const afterReload = await readFile(dest, 'utf8');
    expect(afterReload).toBe(`${JSON.stringify(afterUpgrade, null, 2)}\n`);
    expect(catalog.entries()[0]?.resumeHandle).toBe('thread-v1-codex');
  });

  it('skips entries that have no handle to fold', () => {
    const { document, upgraded } = upgradeCatalogDocument([
      {
        key: 'k',
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp',
        status: 'active',
        updatedAt: 1,
      },
    ]);
    expect(upgraded).toBe(true);
    expect(document.entries).toEqual([]);
  });

  it('rejects an unsupported schemaVersion instead of treating it as empty v1', () => {
    const future = {
      schemaVersion: 3,
      entries: [
        {
          key: 'k',
          scopeId: 'chat-1',
          agentId: 'codex' as const,
          cwdRealpath: '/repo',
          policyFingerprint: 'fp',
          status: 'active' as const,
          updatedAt: 1,
          resumeHandle: 'future-handle',
        },
      ],
    };
    expect(() => upgradeCatalogDocument(future)).toThrow(UnsupportedCatalogSchemaError);
    expect(() => upgradeCatalogDocument(future)).toThrow(/schemaVersion: 3/);
  });

  it('does not wipe an unsupported schemaVersion catalog on load or later upsert', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-unsupported-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const dest = join(dir, 'sessions.json.catalog.json');
    const future = {
      schemaVersion: 3,
      entries: [
        {
          key: 'keep',
          scopeId: 'chat-1',
          agentId: 'codex',
          cwdRealpath: '/repo',
          policyFingerprint: 'fp',
          status: 'active',
          updatedAt: 1,
          resumeHandle: 'future-handle',
        },
      ],
    };
    const payload = `${JSON.stringify(future, null, 2)}\n`;
    await writeFile(dest, payload);

    const catalog = new SessionCatalog(dest);
    await catalog.load();
    expect(catalog.entries()).toEqual([]);
    expect(await readFile(dest, 'utf8')).toBe(payload);

    catalog.upsertActive({
      scopeId: 'chat-new',
      agentId: 'claude',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp',
      resumeHandle: 'should-not-clobber',
      now: 2,
    });
    await catalog.flush();
    expect(await readFile(dest, 'utf8')).toBe(payload);
  });

  it('keeps in-memory v1 entries when upgrade persist fails so a later upsert cannot wipe them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-persist-fail-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const dest = join(dir, 'sessions.json.catalog.json');
    await copyFile(join(fixtureRoot, 'catalog-v1-codex.json'), dest);
    const original = await readFile(dest, 'utf8');

    const persistSpy = vi
      .spyOn(SessionCatalog.prototype as unknown as { persist(): Promise<void> }, 'persist')
      .mockRejectedValueOnce(new Error('disk full'));

    const catalog = new SessionCatalog(dest);
    await catalog.load();
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(catalog.entries()).toHaveLength(1);
    expect(catalog.entries()[0]?.resumeHandle).toBe('thread-v1-codex');
    expect(await readFile(dest, 'utf8')).toBe(original);

    catalog.upsertActive({
      scopeId: 'chat-2',
      agentId: 'claude',
      cwdRealpath: '/PINNED_CWD',
      policyFingerprint: 'PINNED_FP',
      resumeHandle: 'sess-new',
      now: 2,
    });
    await catalog.flush();

    const persisted = JSON.parse(await readFile(dest, 'utf8')) as {
      schemaVersion: number;
      entries: Array<{ resumeHandle: string }>;
    };
    expect(persisted.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    expect(persisted.entries.map((entry) => entry.resumeHandle).sort()).toEqual([
      'sess-new',
      'thread-v1-codex',
    ]);
  });
});
