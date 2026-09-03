import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CATALOG_SCHEMA_VERSION,
  upgradeCatalogDocument,
} from '../../../src/session/migrations.js';
import { SessionCatalog } from '../../../src/session/catalog.js';

const fixtureRoot = join(process.cwd(), 'tests/fixtures/sessions');
const cleanups: Array<() => Promise<void>> = [];

describe('catalog v1 to v2 upgrade', () => {
  afterEach(async () => {
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
});
