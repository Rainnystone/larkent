import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_SCHEMA_VERSION, migrateCatalog } from '../../../src/session/migrations.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import {
  PIN_AGENT_KINDS,
  pinAgentKind,
} from '../../helpers/scripted-jsonl-cli.js';

const cleanups: Array<() => Promise<void>> = [];
const fixtureRoot = join(process.cwd(), 'tests/fixtures/sessions');

describe('catalog v1 to v2 migrations', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('folds v1 sessionId and threadId into resumeHandle and sets schemaVersion 2', () => {
    const v1 = [
      {
        key: 'chat-1\u001fclaude\u001f/repo\u001ffp',
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp',
        status: 'active',
        updatedAt: 1,
        sessionId: 'sess-claude',
      },
      {
        key: 'chat-1\u001fcodex\u001f/repo\u001ffp',
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp',
        status: 'active',
        updatedAt: 2,
        threadId: 'thread-codex',
      },
    ];
    const { document, dirty } = migrateCatalog(v1);
    expect(dirty).toBe(true);
    expect(document.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    expect(document.entries).toEqual([
      {
        key: 'chat-1\u001fclaude\u001f/repo\u001ffp',
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp',
        status: 'active',
        updatedAt: 1,
        resumeHandle: 'sess-claude',
      },
      {
        key: 'chat-1\u001fcodex\u001f/repo\u001ffp',
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp',
        status: 'active',
        updatedAt: 2,
        resumeHandle: 'thread-codex',
      },
    ]);
  });

  it('treats missing schemaVersion as 1', () => {
    const { document, dirty } = migrateCatalog({
      entries: [
        {
          key: 'k',
          scopeId: 'chat-1',
          agentId: 'kimi',
          cwdRealpath: '/repo',
          policyFingerprint: 'fp',
          status: 'active',
          updatedAt: 1,
          sessionId: 'sess-kimi',
        },
      ],
    });
    expect(dirty).toBe(true);
    expect(document.schemaVersion).toBe(2);
    expect(document.entries).toEqual([
      {
        key: 'k',
        scopeId: 'chat-1',
        agentId: 'kimi',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp',
        status: 'active',
        updatedAt: 1,
        resumeHandle: 'sess-kimi',
      },
    ]);
  });

  it('reloads a current v2 document as a no-op', () => {
    const current = {
      schemaVersion: 2,
      entries: [
        {
          key: 'k',
          scopeId: 'chat-1',
          agentId: 'grok',
          cwdRealpath: '/repo',
          policyFingerprint: 'fp',
          status: 'active',
          updatedAt: 1,
          resumeHandle: 'sess-grok',
        },
      ],
    };
    const first = migrateCatalog(current);
    expect(first.dirty).toBe(false);
    const second = migrateCatalog(first.document);
    expect(second.dirty).toBe(false);
    expect(second.document).toEqual(first.document);
  });

  it.each(PIN_AGENT_KINDS)(
    'loads the committed v1 %s fixture, writes resumeHandle, and reloads as a no-op',
    async (kind) => {
      const pinned = pinAgentKind(kind);
      const dir = await mkdtemp(join(tmpdir(), `catalog-migrate-${pinned}-`));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const dest = join(dir, 'sessions.json.catalog.json');
      await copyFile(join(fixtureRoot, `catalog-v1-${pinned}.json`), dest);
      const catalog = new SessionCatalog(dest);
      await catalog.load();
      const entries = catalog.entries();
      expect(entries).toHaveLength(1);
      const expected =
        pinned === 'codex' ? 'thread-v1-codex' : `sess-v1-${pinned}`;
      expect(entries[0]?.resumeHandle).toBe(expected);
      expect(entries[0]).not.toHaveProperty('sessionId');
      expect(entries[0]).not.toHaveProperty('threadId');

      const upgraded = JSON.parse(await readFile(dest, 'utf8')) as {
        schemaVersion: number;
        entries: Array<Record<string, unknown>>;
      };
      expect(upgraded.schemaVersion).toBe(2);
      expect(upgraded.entries[0]?.resumeHandle).toBe(expected);
      expect(upgraded.entries[0]).not.toHaveProperty('sessionId');
      expect(upgraded.entries[0]).not.toHaveProperty('threadId');

      const beforeReload = await readFile(dest, 'utf8');
      await catalog.load();
      expect(await readFile(dest, 'utf8')).toBe(beforeReload);
    },
  );

  it('does not rewrite a current v2 catalog file on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-migrate-v2-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const dest = join(dir, 'sessions.json.catalog.json');
    const payload = `${JSON.stringify(
      {
        schemaVersion: 2,
        entries: [
          {
            key: 'chat-1\u001fcursor\u001f/repo\u001ffp',
            scopeId: 'chat-1',
            agentId: 'cursor',
            cwdRealpath: '/repo',
            policyFingerprint: 'fp',
            status: 'active',
            updatedAt: 1,
            resumeHandle: 'sess-cursor',
          },
        ],
      },
      null,
      2,
    )}\n`;
    await writeFile(dest, payload);
    const catalog = new SessionCatalog(dest);
    await catalog.load();
    expect(await readFile(dest, 'utf8')).toBe(payload);
    expect(catalog.entries()[0]?.resumeHandle).toBe('sess-cursor');
  });
});
