import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../../../src/platform/atomic-write';
import { upgradeWorkspaceDocument } from '../../../src/workspace/store-format';
import { WorkspaceStore } from '../../../src/workspace/store';

vi.mock('../../../src/platform/atomic-write', async original => {
  const actual = await original<typeof import('../../../src/platform/atomic-write')>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});
const atomic = vi.mocked(writeFileAtomic);
const actualAtomic = async () => (await vi.importActual<typeof import('../../../src/platform/atomic-write')>('../../../src/platform/atomic-write')).writeFileAtomic;
beforeEach(async () => { atomic.mockReset().mockImplementation(await actualAtomic()); });
async function fixture(run: (store: WorkspaceStore, file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-v2-'));
  const file = join(dir, 'workspaces.json');
  try { await run(new WorkspaceStore(file), file); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

it('migrates all topic and named mappings once without changing bytes or mtime on reload', async () => {
  await fixture(async (store, file) => {
    const legacy = { chats: { 'oc_same:topic_a': { cwd: '/a' }, 'oc_same:topic_b': { cwd: '/b' } }, named: { oldAlias: '/old', 'profile-a\u001fowner\u001fscope\u001fwork': '/scoped' } };
    await writeFile(file, JSON.stringify(legacy));
    await store.load();
    expect(store.listCwds()).toEqual({ 'oc_same:topic_a': '/a', 'oc_same:topic_b': '/b' });
    expect(store.listNamed()).toEqual(legacy.named);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 2, ...legacy });
    const bytes = await readFile(file, 'utf8');
    const before = await stat(file);
    await new WorkspaceStore(file).load();
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    if (process.platform !== 'win32') expect(before.mode & 0o777).toBe(0o600);
  });
});

it.each(['{', 'null', '[]', '{"schemaVersion":99}', '{"chats":[]}', '{"named":null}', '{"schemaVersion":2,"chats":{}}', '{"schemaVersion":2,"chats":null,"named":{}}', '{"schemaVersion":2,"chats":{},"named":[]}', '{"schemaVersion":2,"chats":{},"named":{"bad":2}}', '{"schemaVersion":2,"chats":{"bad":{"cwd":2}},"named":{}}'])('freezes damaged/unsupported load and preserves bytes: %s', async text => {
  await fixture(async (store, file) => {
    await writeFile(file, text);
    await expect(store.load()).rejects.toBeDefined();
    expect(() => store.setCwd('a', '/a')).toThrow();
    expect(() => store.saveNamed('a', '/a')).toThrow();
    expect(() => store.removeCwd('absent')).toThrow();
    expect(() => store.removeNamed('absent')).toThrow();
    await expect(store.flush()).rejects.toBeDefined();
    expect(await readFile(file, 'utf8')).toBe(text);
  });
});

it('creates v2 when absent and preserves constructor-time mutations and own keys across reload/removal', async () => {
  await fixture(async (store, file) => {
    await store.load();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 2, chats: {}, named: {} });
    const fresh = new WorkspaceStore(file);
    expect(fresh.getNamed('toString')).toBeUndefined();
    expect(fresh.removeCwd('toString')).toBe(false);
    expect(fresh.removeNamed('constructor')).toBe(false);
    fresh.setCwd('__proto__', '/proto');
    fresh.saveNamed('__proto__', '/named');
    await fresh.flush();
    await fresh.load();
    expect(fresh.cwdFor('__proto__')).toBe('/proto');
    expect(fresh.getNamed('__proto__')).toBe('/named');
    expect(fresh.listCwds()).toEqual(JSON.parse('{"__proto__":"/proto"}'));
    expect(fresh.listCwds('__')).toEqual(JSON.parse('{"__proto__":"/proto"}'));
    expect(fresh.listNamed()).toEqual(JSON.parse('{"__proto__":"/named"}'));
    expect(Object.getPrototypeOf(fresh.listCwds())).toBe(Object.prototype);
    expect(fresh.removeCwd('__proto__')).toBe(true);
    expect(fresh.removeNamed('__proto__')).toBe(true);
    await fresh.flush();
    await fresh.load();
    expect(fresh.cwdFor('__proto__')).toBeUndefined();
    expect(fresh.getNamed('__proto__')).toBeUndefined();
    fresh.setCwd('__proto__', '/new');
    fresh.saveNamed('__proto__', '/new-named');
    await fresh.flush();
    await fresh.load();
    expect(fresh.cwdFor('__proto__')).toBe('/new');
    expect(fresh.getNamed('__proto__')).toBe('/new-named');
  });
});

it('preserves prior memory and legacy bytes on migration rename failure until explicit successful reload', async () => {
  await fixture(async (store, file) => {
    store.setCwd('prior', '/prior');
    await store.flush();
    const legacy = '{"chats":{"next":{"cwd":"/next"}},"named":{}}';
    await writeFile(file, legacy);
    const failure = new Error('rename denied');
    const actual = await actualAtomic();
    atomic.mockImplementationOnce((p, data, opts) => actual(p, data, { ...opts, rename: async () => { throw failure; } }));
    await expect(store.load()).rejects.toBe(failure);
    expect(store.cwdFor('prior')).toBe('/prior');
    expect(store.cwdFor('next')).toBeUndefined();
    expect(() => store.saveNamed('blocked', '/blocked')).toThrow(failure);
    await expect(store.flush()).rejects.toBe(failure);
    expect(await readFile(file, 'utf8')).toBe(legacy);
    await store.load();
    store.saveNamed('ok', '/ok');
    await store.flush();
    expect(store.cwdFor('next')).toBe('/next');
  });
});

it('reports first save failure, skips later queued writes and freezes every mutation until reload', async () => {
  await fixture(async (store, file) => {
    await writeFile(file, '{"schemaVersion":2,"chats":{},"named":{}}');
    await store.load();
    const bytes = await readFile(file, 'utf8');
    const failure = new Error('rename denied');
    const actual = await actualAtomic();
    atomic.mockImplementationOnce((p, data, opts) => actual(p, data, { ...opts, rename: async () => { throw failure; } }));
    store.setCwd('a', '/first');
    store.saveNamed('n', '/second');
    await expect(store.flush()).rejects.toBe(failure);
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect(() => store.setCwd('a', '/lost')).toThrow(failure);
    expect(() => store.saveNamed('n', '/lost')).toThrow(failure);
    expect(() => store.removeCwd('a')).toThrow(failure);
    expect(() => store.removeNamed('n')).toThrow(failure);
    expect(store.cwdFor('a')).toBe('/first');
    expect(store.getNamed('n')).toBe('/second');
    await expect(store.flush()).rejects.toBe(failure);
    await store.load();
    expect(store.cwdFor('a')).toBeUndefined();
    store.setCwd('ok', '/ok');
    await store.flush();
  });
});

it('drains enqueue-time snapshots before shared reload and rejects mutations during loading', async () => {
  await fixture(async (store, file) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const actual = await actualAtomic();
    const snapshots: unknown[] = [];
    atomic.mockImplementation(async (...args) => { snapshots.push(JSON.parse(String(args[1]))); await gate; await actual(...args); });
    store.setCwd('a', '/first');
    store.setCwd('a', '/second');
    const loading = store.load();
    expect(store.load()).toBe(loading);
    expect(() => store.setCwd('lost', '/lost')).toThrow(/load/i);
    release();
    await Promise.all([loading, store.flush()]);
    expect(snapshots).toEqual([
      { schemaVersion: 2, chats: { a: { cwd: '/first' } }, named: {} },
      { schemaVersion: 2, chats: { a: { cwd: '/second' } }, named: {} },
    ]);
    expect(store.cwdFor('a')).toBe('/second');
    expect(JSON.parse(await readFile(file, 'utf8')).chats.a.cwd).toBe('/second');
  });
});

it('discards invalid legacy mappings, fills missing maps, and preserves own prototype-shaped keys', async () => {
  await fixture(async (store, file) => {
    await writeFile(file, '{"chats":{"__proto__":{"cwd":"/proto"},"empty":{"cwd":""},"bad":null,"array":[],"number":{"cwd":2}},"named":{"__proto__":"/named","empty":"","bad":false}}');
    await store.load();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(JSON.parse('{"schemaVersion":2,"chats":{"__proto__":{"cwd":"/proto"},"empty":{"cwd":""}},"named":{"__proto__":"/named","empty":""}}'));
    expect(store.cwdFor('__proto__')).toBe('/proto');
    expect(store.getNamed('__proto__')).toBe('/named');
    await writeFile(file, '{}');
    await store.load();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 2, chats: {}, named: {} });
  });
});


it('upgrades without mutating the input or exposing prototype keys as mappings', () => {
  const raw = JSON.parse('{"chats":{"__proto__":{"cwd":"/a"},"bad":null},"named":{"__proto__":"/n","bad":1}}');
  const before = structuredClone(raw);
  const result = upgradeWorkspaceDocument(raw);
  expect(result.upgraded).toBe(true);
  expect(result.document).toEqual(JSON.parse('{"schemaVersion":2,"chats":{"__proto__":{"cwd":"/a"}},"named":{"__proto__":"/n"}}'));
  expect(raw).toEqual(before);
  expect(Object.getPrototypeOf(result.document.chats)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(result.document.named)).toBe(Object.prototype);
  expect(upgradeWorkspaceDocument(result.document).upgraded).toBe(false);
});

it('keeps a failed reload frozen after a save failure and recovers only from a valid document', async () => {
  await fixture(async (store, file) => {
    await store.load();
    const actual = await actualAtomic();
    const failure = new Error('rename denied');
    atomic.mockImplementationOnce((p, data, opts) => actual(p, data, { ...opts, rename: async () => { throw failure; } }));
    store.setCwd('a', '/unsaved');
    await expect(store.flush()).rejects.toBe(failure);
    await writeFile(file, '{"schemaVersion":99}');
    await expect(store.load()).rejects.toThrow(/Unsupported/);
    expect(() => store.removeCwd('a')).toThrow(/Unsupported/);
    await expect(store.flush()).rejects.toThrow(/Unsupported/);
    await writeFile(file, '{"schemaVersion":2,"chats":{},"named":{}}');
    await store.load();
    store.saveNamed('ok', '/ok');
    await store.flush();
  });
});

it('retains even an undefined load rejection until a successful retry', async () => {
  await fixture(async (store, file) => {
    atomic.mockRejectedValueOnce(undefined);
    await expect(store.load()).rejects.toBeUndefined();
    await expect(store.flush()).rejects.toBeUndefined();
    let thrown = false;
    try { store.setCwd('a', '/a'); } catch (error) { thrown = true; expect(error).toBeUndefined(); }
    expect(thrown).toBe(true);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await store.load();
    store.setCwd('a', '/a');
    await store.flush();
  });
});


it('freezes on a filesystem read error without replacing the existing path', async () => {
  await fixture(async (store, file) => {
    await mkdir(file);
    await expect(store.load()).rejects.toBeDefined();
    expect(() => store.saveNamed('lost', '/lost')).toThrow();
    await expect(store.flush()).rejects.toBeDefined();
    expect((await stat(file)).isDirectory()).toBe(true);
    await rm(file, { recursive: true });
    await store.load();
    store.saveNamed('ok', '/ok');
    await store.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).named).toEqual({ ok: '/ok' });
  });
});
