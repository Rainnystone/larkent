import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../../../src/platform/atomic-write';
import { upgradeSessionDocument } from '../../../src/session/store-format';
import { SessionStore } from '../../../src/session/store';

describe('SessionStore v2', () => {
  it('migrates paired sessions and timeout-only entries once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-v2-'));
    try {
      const file = join(dir, 'sessions.json');
      await writeFile(file, JSON.stringify({
        'oc_a:thread_1': { sessionId: 'session-a', cwd: '/work/a', updatedAt: 10, idleTimeoutMinutes: 7 },
        'oc_a:thread_2': { updatedAt: 11, idleTimeoutMinutes: 0 },
      }));
      const store = new SessionStore(file);
      await store.load();
      expect(store.resumeFor('oc_a:thread_1', '/work/a')).toBe('session-a');
      expect(store.getRaw('oc_a:thread_2')).toEqual({ updatedAt: 11, idleTimeoutMinutes: 0 });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 2, entries: {
        'oc_a:thread_1': { resumeHandle: 'session-a', cwd: '/work/a', updatedAt: 10, idleTimeoutMinutes: 7 },
        'oc_a:thread_2': { updatedAt: 11, idleTimeoutMinutes: 0 },
      } });
      const bytes = await readFile(file, 'utf8');
      const before = await stat(file);
      await new SessionStore(file).load();
      expect(await readFile(file, 'utf8')).toBe(bytes);
      expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
      expect(before.mode & 0o777).toBe(0o600);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// Atomic-write remains real; injection fails before rename, preserving the original.
vi.mock('../../../src/platform/atomic-write', async (original) => {
  const actual = await original<typeof import('../../../src/platform/atomic-write')>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});
const atomic = vi.mocked(writeFileAtomic);
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write')>('../../../src/platform/atomic-write');
  atomic.mockReset().mockImplementation(actual.writeFileAtomic);
});

async function fixture(run: (store: SessionStore, file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'session-errors-'));
  try { await run(new SessionStore(join(dir, 'sessions.json')), join(dir, 'sessions.json')); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

it('creates v2 and keeps all mutation output reloadable, including timeout reset', async () => {
  await fixture(async (store, file) => {
    await store.load();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 2, entries: {} });
    store.setIdleTimeoutMinutes('a', 7.8);
    store.set('a', 'handle', '/work');
    expect(store.resumeFor('a', '/other')).toBeUndefined();
    store.clear('a');
    expect(store.getIdleTimeoutMinutes('a')).toBe(7);
    expect(store.clearIdleTimeoutOverride('a')).toBe(true);
    expect(store.clearIdleTimeoutOverride('a')).toBe(false);
    expect(store.getRaw('a')).toBeUndefined();
    store.setIdleTimeoutMinutes('off', -5);
    store.setIdleTimeoutMinutes('max', 200);
    await store.flush();
    await store.load();
    expect(store.getIdleTimeoutMinutes('off')).toBe(0);
    expect(store.getIdleTimeoutMinutes('max')).toBe(120);
  });
});

it.each(['{', 'null', '[]', '{"schemaVersion":99}', '{"schemaVersion":2,"entries":{"a":{"updatedAt":1}}}', '{"schemaVersion":2,"entries":{"a":{"updatedAt":1,"sessionId":"old","cwd":"/a"}}}', '{"schemaVersion":2,"entries":{"a":{"updatedAt":1,"idleTimeoutMinutes":121}}}'])('rejects damaged or unsupported documents without overwriting: %s', async text => {
  await fixture(async (store, file) => {
    await writeFile(file, text);
    await expect(store.load()).rejects.toBeDefined();
    expect(() => store.set('a', 'h', '/a')).toThrow();
    expect(() => store.clear('absent')).toThrow();
    expect(() => store.setIdleTimeoutMinutes('a', 1)).toThrow();
    expect(() => store.clearIdleTimeoutOverride('absent')).toThrow();
    await expect(store.flush()).rejects.toBeDefined();
    expect(await readFile(file, 'utf8')).toBe(text);
  });
});

it('preserves original and prior memory on failed migration and recovers only on successful load', async () => {
  await fixture(async (store, file) => {
    store.set('prior', 'kept', '/old');
    await store.flush();
    const legacy = '{"new":{"sessionId":"new-h","cwd":"/new","updatedAt":1}}';
    await writeFile(file, legacy);
    const failure = new Error('rename failed');
    const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write')>('../../../src/platform/atomic-write');
    atomic.mockImplementationOnce((path, data, opts) => actual.writeFileAtomic(path, data, { ...opts, rename: async () => { throw failure; } }));
    await expect(store.load()).rejects.toBe(failure);
    expect(store.resumeFor('prior', '/old')).toBe('kept');
    expect(store.getRaw('new')).toBeUndefined();
    await expect(store.flush()).rejects.toBe(failure);
    expect(await readFile(file, 'utf8')).toBe(legacy);
    await store.load();
    store.set('post', 'recovered', '/new');
    await store.flush();
    expect(store.resumeFor('new', '/new')).toBe('new-h');
  });
});

it('locks first save failure, skips queued writes, and leaves memory unchanged by later mutations', async () => {
  await fixture(async (store, file) => {
    await writeFile(file, '{"schemaVersion":2,"entries":{}}');
    await store.load();
    const bytes = await readFile(file, 'utf8');
    const failure = { reason: 'disk failure' };
    const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write')>('../../../src/platform/atomic-write');
    atomic.mockImplementationOnce((path, data, opts) => actual.writeFileAtomic(path, data, { ...opts, rename: async () => { throw failure; } }));
    store.set('a', 'first', '/a');
    store.set('a', 'second', '/a');
    await expect(store.flush()).rejects.toBe(failure);
    expect(await readFile(file, 'utf8')).toBe(bytes);
    let caught: unknown;
    try { store.set('a', 'third', '/a'); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(store.resumeFor('a', '/a')).toBe('second');
    await expect(store.flush()).rejects.toBe(failure);
    await store.load();
    expect(store.getRaw('a')).toBeUndefined();
    store.set('a', 'recovered', '/a');
    await store.flush();
  });
});

it('drains old writes before reload, shares concurrent loading and rejects mutation until publication', async () => {
  await fixture(async (store, file) => {
    const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write')>('../../../src/platform/atomic-write');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    atomic.mockImplementationOnce(async (...args) => { await gate; await actual.writeFileAtomic(...args); });
    store.set('a', 'first', '/a');
    store.set('a', 'second', '/a');
    const load = store.load();
    const concurrent = store.load();
    expect(() => store.set('b', 'lost', '/b')).toThrow(/load/i);
    release();
    await Promise.all([load, concurrent, store.flush()]);
    expect(store.resumeFor('a', '/a')).toBe('second');
    expect(JSON.parse(await readFile(file, 'utf8')).entries.a.resumeHandle).toBe('second');
  });
});

it('normalizes legacy timeouts, discards invalid entries, and never mutates its input', () => {
  const raw = {
    paired: { sessionId: 's', cwd: '/a', updatedAt: 1, idleTimeoutMinutes: 7.9 },
    partial: { sessionId: 'orphan', updatedAt: 2, idleTimeoutMinutes: -1 },
    max: { updatedAt: 3, idleTimeoutMinutes: 200 },
    missing: { sessionId: 'orphan', updatedAt: 4 },
    badTime: { updatedAt: Infinity, idleTimeoutMinutes: 1 },
    badTimeout: { updatedAt: 1, idleTimeoutMinutes: NaN },
  };
  const copy = structuredClone(raw);
  expect(upgradeSessionDocument(raw)).toEqual({ upgraded: true, document: { schemaVersion: 2, entries: {
    paired: { resumeHandle: 's', cwd: '/a', updatedAt: 1, idleTimeoutMinutes: 7 },
    partial: { updatedAt: 2, idleTimeoutMinutes: 0 },
    max: { updatedAt: 3, idleTimeoutMinutes: 120 },
  } } });
  expect(raw).toEqual(copy);
});

it.each([
  { entries: [] },
  { entries: {}, extra: true },
  { entries: { a: null } },
  { entries: { a: { updatedAt: Infinity, idleTimeoutMinutes: 1 } } },
  { entries: { a: { updatedAt: '1', idleTimeoutMinutes: 1 } } },
  { entries: { a: { updatedAt: 1, idleTimeoutMinutes: 1.5 } } },
  { entries: { a: { updatedAt: 1, idleTimeoutMinutes: NaN } } },
  { entries: { a: { updatedAt: 1, idleTimeoutMinutes: -1 } } },
  { entries: { a: { updatedAt: 1, resumeHandle: 'h' } } },
  { entries: { a: { updatedAt: 1, cwd: '/a', idleTimeoutMinutes: 1 } } },
  { entries: { a: { updatedAt: 1, resumeHandle: 1, cwd: '/a' } } },
  { entries: { a: { updatedAt: 1, resumeHandle: 'h', cwd: 1 } } },
  { entries: { a: { updatedAt: 1, resumeHandle: 'h', cwd: '/a', sessionId: 'old' } } },
])('strictly rejects invalid v2 fields: %j', fields => {
  expect(() => upgradeSessionDocument({ schemaVersion: 2, ...fields })).toThrow();
});

it('persists enqueue-time snapshots in order and supports arbitrary scope keys', async () => {
  await fixture(async (store, file) => {
    const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write')>('../../../src/platform/atomic-write');
    const snapshots: unknown[] = [];
    atomic.mockImplementation(async (...args) => {
      snapshots.push(JSON.parse(String(args[1])));
      await actual.writeFileAtomic(...args);
    });
    store.set('__proto__', 'first', '/a');
    store.set('__proto__', 'second', '/a');
    await store.flush();
    expect(snapshots).toMatchObject([
      { schemaVersion: 2, entries: JSON.parse('{"__proto__":{"resumeHandle":"first","cwd":"/a"}}') },
      { schemaVersion: 2, entries: JSON.parse('{"__proto__":{"resumeHandle":"second","cwd":"/a"}}') },
    ]);
    await store.load();
    expect(store.resumeFor('__proto__', '/a')).toBe('second');
    expect(store.getRaw('toString')).toBeUndefined();
    const bytes = await readFile(file, 'utf8');
    expect(() => store.setIdleTimeoutMinutes('bad', NaN)).toThrow();
    await store.flush();
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });
});

it('removes a timeout without losing a resumable session and clears sessions without preferences', async () => {
  await fixture(async store => {
    store.set('a', 'h', '/a');
    store.setIdleTimeoutMinutes('a', 0);
    expect(store.clearIdleTimeoutOverride('a')).toBe(true);
    await store.flush();
    await store.load();
    expect(store.resumeFor('a', '/a')).toBe('h');
    expect(store.getIdleTimeoutMinutes('a')).toBeUndefined();
    store.clear('a');
    await store.flush();
    await store.load();
    expect(store.getRaw('a')).toBeUndefined();
  });
});

it('freezes a failed initial creation even when its rejection is undefined', async () => {
  await fixture(async (store, file) => {
    atomic.mockRejectedValueOnce(undefined);
    await expect(store.load()).rejects.toBeUndefined();
    await expect(store.flush()).rejects.toBeUndefined();
    let thrown = false;
    try { store.set('a', 'h', '/a'); } catch (error) { thrown = true; expect(error).toBeUndefined(); }
    expect(thrown).toBe(true);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await store.load();
    store.setIdleTimeoutMinutes('a', 1);
    await store.flush();
    await store.load();
    expect(store.getIdleTimeoutMinutes('a')).toBe(1);
  });
});
