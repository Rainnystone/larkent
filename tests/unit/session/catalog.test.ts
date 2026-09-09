import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionCatalog,
  sessionCatalogKey,
} from '../../../src/session/catalog.js';
import { CATALOG_SCHEMA_VERSION } from '../../../src/session/migrations.js';

import { writeFileAtomic } from '../../../src/platform/atomic-write.js';

vi.mock('../../../src/platform/atomic-write.js', async (original) => {
  const actual = await original<typeof import('../../../src/platform/atomic-write.js')>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});
const atomic = vi.mocked(writeFileAtomic);
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write.js')>('../../../src/platform/atomic-write.js');
  atomic.mockReset().mockImplementation(actual.writeFileAtomic);
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('agent-aware session catalog', () => {

  it('keys entries by scope, agent, cwd realpath, and policy fingerprint', () => {
    expect(
      sessionCatalogKey({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBe('chat-1\x1fclaude\x1f/repo\x1ffp-1');
  });

  it('stores Claude and Codex handles in isolated active entries', async () => {
    const file = await path();
    const catalog = new SessionCatalog(file);

    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      resumeHandle: 'sess-1',
      now: 1000,
    });
    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      resumeHandle: 'thread-1',
      now: 2000,
    });

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ resumeHandle: 'sess-1', agentId: 'claude' });
    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ resumeHandle: 'thread-1', agentId: 'codex' });
    await catalog.flush();
    const persisted = JSON.parse(await readFile(file, 'utf8')) as {
      schemaVersion: number;
      entries: Array<{ resumeHandle: string }>;
    };
    expect(persisted.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    expect(persisted.entries.map((entry) => entry.resumeHandle).sort()).toEqual([
      'sess-1',
      'thread-1',
    ]);
  });

  it('rejects missing resumeHandle and does not auto-resume damaged entries', async () => {
    const catalog = new SessionCatalog(await path());

    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        resumeHandle: '',
        now: 1000,
      }),
    ).toThrow(/resumeHandle/);

    await catalog.replaceForTest([
      {
        key: sessionCatalogKey({
          scopeId: 'chat-1',
          agentId: 'codex',
          cwdRealpath: '/repo',
          policyFingerprint: 'fp-1',
        }),
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        resumeHandle: '',
        status: 'active',
        updatedAt: 1000,
      },
    ]);

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBeUndefined();
    await catalog.flush();
  });

  it('archives only the current agent/cwd/fingerprint entry for a new conversation', async () => {
    const catalog = new SessionCatalog(await path());
    const base = {
      scopeId: 'chat-1',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };
    catalog.upsertActive({ ...base, agentId: 'claude', resumeHandle: 'sess-1', now: 1000 });
    catalog.upsertActive({ ...base, agentId: 'codex', resumeHandle: 'thread-1', now: 1000 });

    expect(catalog.archiveActive({ ...base, agentId: 'claude', now: 2000 })).toBe(true);

    expect(catalog.activeFor({ ...base, agentId: 'claude' })).toBeUndefined();
    expect(catalog.activeFor({ ...base, agentId: 'codex' })).toMatchObject({
      resumeHandle: 'thread-1',
    });
    expect(catalog.entries().filter((entry) => entry.status === 'archived')).toHaveLength(1);
    await catalog.flush();
  });

  it('garbage-collects old archived entries, per-scope overflow, and profile overflow', async () => {
    const catalog = new SessionCatalog(await path());
    await catalog.replaceForTest([
      ...Array.from({ length: 25 }, (_, i) =>
        entry(`chat-1`, `sess-${i}`, 50_000 + i, `fp-${i}`),
      ),
      ...Array.from({ length: 981 }, (_, i) =>
        entry(`chat-${i + 2}`, `other-${i}`, 20_000 + i, `fp-other-${i}`),
      ),
      {
        ...entry('chat-old', 'old', 1),
        status: 'archived',
      },
    ]);

    catalog.gc({
      now: 100 * 24 * 60 * 60 * 1000,
      maxArchivedAgeMs: 90 * 24 * 60 * 60 * 1000,
      maxEntriesPerScope: 20,
      maxEntriesPerProfile: 1000,
    });

    expect(catalog.entries().some((item) => item.resumeHandle === 'old')).toBe(false);
    expect(catalog.entries().filter((item) => item.scopeId === 'chat-1')).toHaveLength(20);
    expect(catalog.entries()).toHaveLength(1000);
    await catalog.flush();
  });
});

async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-catalog-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'catalog.json');
}

function entry(
  scopeId: string,
  resumeHandle: string,
  updatedAt: number,
  policyFingerprint = 'fp-1',
) {
  const identity = {
    scopeId,
    agentId: 'claude' as const,
    cwdRealpath: '/repo',
    policyFingerprint,
  };
  return {
    key: sessionCatalogKey(identity),
    ...identity,
    resumeHandle,
    status: 'active' as const,
    updatedAt,
  };
}

const identity = { scopeId: 'a', agentId: 'codex' as const, cwdRealpath: '/a', policyFingerprint: 'fp' };

it.each(['claude', 'codex', 'kimi', 'grok', 'cursor'])('rejects failed %s v1 upgrade before publishing and preserves original bytes', async kind => {
  const file = await path();
  const catalog = new SessionCatalog(file);
  catalog.upsertActive({ ...identity, resumeHandle: 'previous' });
  await catalog.flush();
  await copyFile(join(process.cwd(), 'tests/fixtures/sessions', `catalog-v1-${kind}.json`), file);
  const original = await readFile(file, 'utf8');
  const failure = new Error('migration disk full');
  atomic.mockRejectedValueOnce(failure);
  await expect(catalog.load()).rejects.toBe(failure);
  expect(catalog.activeFor(identity)?.resumeHandle).toBe('previous');
  expect(catalog.entries()).toHaveLength(1);
  expect(() => catalog.upsertActive({ ...identity, resumeHandle: 'lost' })).toThrow(failure);
  await expect(catalog.flush()).rejects.toBe(failure);
  expect(await readFile(file, 'utf8')).toBe(original);
  await catalog.load();
  const handle = kind === 'codex' ? 'thread-v1-codex' : `sess-v1-${kind}`;
  expect(catalog.entries()[0]?.resumeHandle).toBe(handle);
  const bytes = await readFile(file, 'utf8');
  const before = await stat(file);
  const rebuilt = new SessionCatalog(file);
  await rebuilt.load();
  expect(rebuilt.entries()[0]?.resumeHandle).toBe(handle);
  expect(await readFile(file, 'utf8')).toBe(bytes);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  if (process.platform !== 'win32') expect(before.mode & 0o777).toBe(0o600);
});

it.each(['{', 'null', '{"schemaVersion":99,"entries":[]}', '{"schemaVersion":2,"entries":{}}'])('freezes every mutation after load rejects %s', async bytes => {
  const file = await path();
  const catalog = new SessionCatalog(file);
  catalog.upsertActive({ ...identity, resumeHandle: 'previous' });
  await catalog.flush();
  await writeFile(file, bytes);
  await expect(catalog.load()).rejects.toBeDefined();
  expect(() => catalog.upsertActive({ ...identity, resumeHandle: 'lost' })).toThrow();
  expect(() => catalog.archiveActive(identity)).toThrow();
  expect(() => catalog.gc({ maxEntriesPerProfile: 0 })).toThrow();
  await expect(catalog.replaceForTest([])).rejects.toBeDefined();
  await expect(catalog.flush()).rejects.toBeDefined();
  expect(catalog.activeFor(identity)?.resumeHandle).toBe('previous');
  expect(await readFile(file, 'utf8')).toBe(bytes);
});

it('drains pending snapshot writes before reload and blocks every mutation until publication', async () => {
  const file = await path();
  const catalog = new SessionCatalog(file);
  const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write.js')>('../../../src/platform/atomic-write.js');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const written: string[] = [];
  atomic.mockImplementation(async (path, data, opts) => {
    await gate;
    written.push(String(data));
    await actual.writeFileAtomic(path, data, opts);
  });
  catalog.upsertActive({ ...identity, resumeHandle: 'first' });
  catalog.upsertActive({ ...identity, resumeHandle: 'second' });
  const load = catalog.load();
  const secondLoad = catalog.load();
  try {
    expect(() => catalog.upsertActive({ ...identity, resumeHandle: 'lost' })).toThrow(/loading/i);
    expect(() => catalog.archiveActive(identity)).toThrow(/loading/i);
    expect(() => catalog.gc()).toThrow(/loading/i);
    await expect(catalog.replaceForTest([])).rejects.toThrow(/loading/i);
  } finally {
    release();
    await Promise.all([load, secondLoad, catalog.flush()]);
  }
  expect(written.map(text => JSON.parse(text).entries[0].resumeHandle)).toEqual(['first', 'second']);
  expect(catalog.activeFor(identity)?.resumeHandle).toBe('second');
  expect(JSON.parse(await readFile(file, 'utf8')).entries[0].resumeHandle).toBe('second');
});

it('reports the first queued atomic rename failure and recovers only after reload', async () => {
  const file = await path();
  const catalog = new SessionCatalog(file);
  catalog.upsertActive({ ...identity, resumeHandle: 'previous' });
  await catalog.flush();
  const bytes = await readFile(file, 'utf8');
  const failure = new Error('rename failed');
  const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write.js')>('../../../src/platform/atomic-write.js');
  atomic.mockImplementationOnce((file, data, opts) => actual.writeFileAtomic(file, data, { ...opts, rename: async () => { throw failure; } }));
  catalog.upsertActive({ ...identity, resumeHandle: 'first' });
  catalog.upsertActive({ ...identity, resumeHandle: 'second' });
  await expect(catalog.flush()).rejects.toBe(failure);
  expect(await readFile(file, 'utf8')).toBe(bytes);
  expect(() => catalog.archiveActive(identity)).toThrow(failure);
  expect(() => catalog.gc()).toThrow(failure);
  await expect(catalog.replaceForTest([])).rejects.toBe(failure);
  await catalog.load();
  expect(catalog.activeFor(identity)?.resumeHandle).toBe('previous');
  catalog.upsertActive({ ...identity, resumeHandle: 'recovered' });
  await catalog.flush();
});
