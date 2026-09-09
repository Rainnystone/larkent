import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { resolveAppPaths } from '../../../src/config/app-paths';
import * as locks from '../../../src/runtime/locks';
import { readAndPrune } from '../../../src/runtime/registry';
import { Supervisor, type SupervisorOptions } from '../../../src/runtime/supervisor';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function harness(startChannelFn: SupervisorOptions['startChannelFn']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'supervisor-start-stop-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  const configPath = join(root, 'config.json');
  const profile = createDefaultProfileConfig({
    agentKind: 'claude', accounts: { app: { id: 'fake-start-app', secret: 'fake-secret', tenant: 'feishu' } },
  });
  await saveRootConfig(createRootConfig('test', profile), configPath);
  const supervisor = new Supervisor({ configPath, rootDir: root, runPreflight: false, startChannelFn });
  cleanups.push(() => supervisor.shutdown());
  return { supervisor, paths };
}
function bridge(disconnect: () => Promise<void>) {
  return { channel: { botIdentity: { name: 'fake' } }, disconnect } as never;
}

it.each(['profile', 'app'] as const)('leaves legacy stores untouched while another owner holds the %s lock', async kind => {
  const { supervisor, paths } = await harness(async () => bridge(async () => {}));
  await mkdir(paths.profileDir, { recursive: true });
  const catalogFile = `${paths.sessionsFile}.catalog.json`;
  const legacySessions = JSON.stringify({ chat: { sessionId: 'old-session', cwd: 'old-workspace', updatedAt: 1 } });
  const legacyWorkspaces = JSON.stringify({ chats: { chat: { cwd: 'old-workspace' } }, named: { project: 'old-workspace' } });
  await writeFile(paths.sessionsFile, legacySessions);
  await writeFile(catalogFile, '[]');
  await writeFile(paths.workspacesFile, legacyWorkspaces);
  const owner = kind === 'profile'
    ? await locks.acquireProfileRuntimeLock(paths, 'claude')
    : await locks.acquireAppRuntimeLock(paths, 'fake-start-app', 'claude');
  try {
    await expect(supervisor.startProfile('test')).rejects.toMatchObject({ name: 'RuntimeLockConflictError', kind });
    expect(await Promise.all([paths.sessionsFile, catalogFile, paths.workspacesFile].map(file => readFile(file, 'utf8'))))
      .toEqual([legacySessions, '[]', legacyWorkspaces]);
    expect(supervisor.list()).toEqual([]);
    expect(readAndPrune(paths.userRegistryFile)).toEqual([]);
    expect((await locks.checkRuntimeLock(kind === 'profile' ? paths.profileLockFile : paths.appLockFile('fake-start-app'))).locked).toBe(true);
    // The current owner can still persist newer state before yielding the lock.
    await writeFile(paths.sessionsFile, JSON.stringify({ chat: { sessionId: 'latest-session', cwd: 'latest-workspace', updatedAt: 2 } }));
    await writeFile(paths.workspacesFile, JSON.stringify({ chats: { chat: { cwd: 'latest-workspace' } }, named: { project: 'latest-workspace' } }));
  } finally {
    await owner.release();
  }
  await supervisor.startProfile('test');
  expect(supervisor.isOnline('test')).toBe(true);
  expect(JSON.parse(await readFile(paths.sessionsFile, 'utf8'))).toEqual({
    schemaVersion: 2, entries: { chat: { resumeHandle: 'latest-session', cwd: 'latest-workspace', updatedAt: 2 } },
  });
  expect(JSON.parse(await readFile(catalogFile, 'utf8'))).toEqual({ schemaVersion: 2, entries: [] });
  expect(JSON.parse(await readFile(paths.workspacesFile, 'utf8'))).toEqual({
    schemaVersion: 2, chats: { chat: { cwd: 'latest-workspace' } }, named: { project: 'latest-workspace' },
  });
});

it.each(['sessions', 'catalog', 'workspaces'] as const)('releases startup locks after a %s load failure and allows a repaired retry', async store => {
  const { supervisor, paths } = await harness(async () => bridge(async () => {}));
  await mkdir(paths.profileDir, { recursive: true });
  const file = store === 'sessions' ? paths.sessionsFile : store === 'catalog' ? `${paths.sessionsFile}.catalog.json` : paths.workspacesFile;
  await writeFile(file, '{invalid-json');
  await expect(supervisor.startProfile('test')).rejects.toBeInstanceOf(SyntaxError);
  expect(await readFile(file, 'utf8')).toBe('{invalid-json');
  expect(supervisor.list()).toEqual([]);
  expect(readAndPrune(paths.userRegistryFile)).toEqual([]);
  expect((await locks.checkRuntimeLock(paths.profileLockFile)).locked).toBe(false);
  expect((await locks.checkRuntimeLock(paths.appLockFile('fake-start-app'))).locked).toBe(false);
  await writeFile(file, store === 'catalog' ? '[]' : '{}');
  await supervisor.startProfile('test');
  expect(supervisor.isOnline('test')).toBe(true);
});

it.each(['shutdown', 'stopProfile'] as const)('%s waits for the admitted start and duplicate start creates one owner', async method => {
  const entered = deferred();
  const release = deferred();
  let starts = 0;
  let disconnects = 0;
  const { supervisor, paths } = await harness(async () => {
    starts++;
    entered.resolve();
    await release.promise;
    return bridge(async () => { disconnects++; });
  });
  const starting = supervisor.startProfile('test');
  const duplicate = supervisor.startProfile('test');
  const startResult = Promise.allSettled([starting, duplicate]);
  try {
    await entered.promise;
    expect(supervisor.isOnline('test')).toBe(false);
    expect(supervisor.channelFor('test')).toBeUndefined();
    expect(supervisor.controlsFor('test')).toBeDefined();
    expect(supervisor.list()).toEqual([expect.objectContaining({ profile: 'test', online: false, appId: 'fake-start-app' })]);
    await expect(supervisor.restartProfile('test')).rejects.toThrow(/未在运行/);
    const stopping = method === 'shutdown' ? supervisor.shutdown() : supervisor.stopProfile('test');
    let stopped = false;
    const stopResult = stopping.then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(readAndPrune(paths.userRegistryFile)).toHaveLength(1);
    expect((await locks.checkRuntimeLock(paths.profileLockFile)).locked).toBe(true);
    if (method === 'shutdown') await expect(supervisor.startProfile('later')).rejects.toThrow(/shut|clos/i);
    release.resolve();
    expect(await startResult).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
    await stopResult;
    expect(starts).toBe(1);
    expect(disconnects).toBe(1);
    expect(supervisor.isOnline('test')).toBe(false);
    expect(readAndPrune(paths.userRegistryFile)).toEqual([]);
    expect((await locks.checkRuntimeLock(paths.profileLockFile)).locked).toBe(false);
    expect((await locks.checkRuntimeLock(paths.appLockFile('fake-start-app'))).locked).toBe(false);
    if (method === 'stopProfile') {
      await supervisor.startProfile('test');
      expect(supervisor.isOnline('test')).toBe(true);
      expect(starts).toBe(2);
    }
    await supervisor.shutdown();
    await supervisor.shutdown();
  } finally {
    release.resolve();
    await startResult;
    await supervisor.shutdown();
  }
});

it('rolls back the acquired profile lock when the second startup lock fails', async () => {
  const failure = new Error('app acquire failed');
  let starts = 0;
  const { supervisor, paths } = await harness(async () => { starts++; return bridge(async () => {}); });
  const originalProfileAcquire = locks.acquireProfileRuntimeLock;
  let retained: locks.AcquiredRuntimeLock | undefined;
  vi.spyOn(locks, 'acquireProfileRuntimeLock').mockImplementation(async (...args) => {
    retained = await originalProfileAcquire(...args);
    return retained;
  });
  const appAcquire = vi.spyOn(locks, 'acquireAppRuntimeLock').mockRejectedValueOnce(failure);
  try {
    await expect(supervisor.startProfile('test')).rejects.toBe(failure);
    expect(starts).toBe(0);
    expect(supervisor.isOnline('test')).toBe(false);
    expect(supervisor.controlsFor('test')).toBeUndefined();
    expect(supervisor.channelFor('test')).toBeUndefined();
    expect(supervisor.list()).toEqual([]);
    expect(readAndPrune(paths.userRegistryFile)).toEqual([]);
    expect((await locks.checkRuntimeLock(paths.profileLockFile)).locked).toBe(false);
    appAcquire.mockRestore();
    await supervisor.startProfile('test');
    expect(starts).toBe(1);
  } finally {
    await supervisor.stopProfile('test');
    // The BASE regression leaks this real lock; clean it without masking RED.
    if ((await locks.checkRuntimeLock(paths.profileLockFile)).locked) await retained?.release();
  }
});

it('retains failed startup rollback ownership and reports both failures until stop retries cleanup', async () => {
  const startupFailure = new Error('channel startup failed');
  const releaseFailure = new Error('startup profile release failed');
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { supervisor, paths } = await harness(async () => { throw startupFailure; });
  const originalAcquire = locks.acquireProfileRuntimeLock;
  let retained: locks.AcquiredRuntimeLock | undefined;
  vi.spyOn(locks, 'acquireProfileRuntimeLock').mockImplementation(async (...args) => {
    const lock = await originalAcquire(...args);
    retained = lock;
    let attempts = 0;
    return { ...lock, release: async () => {
      if (++attempts === 1) throw releaseFailure;
      await lock.release();
    } };
  });
  try {
    await expect(supervisor.startProfile('test')).rejects.toMatchObject({ errors: [startupFailure, releaseFailure] });
    expect(supervisor.isOnline('test')).toBe(false);
    expect(supervisor.channelFor('test')).toBeUndefined();
    expect(supervisor.controlsFor('test')).toBeDefined();
    expect(supervisor.list()).toEqual([expect.objectContaining({ profile: 'test', online: false })]);
    expect((await locks.checkRuntimeLock(paths.profileLockFile)).locked).toBe(true);
    expect((await locks.checkRuntimeLock(paths.appLockFile('fake-start-app'))).locked).toBe(false);
    await expect(supervisor.startProfile('test')).rejects.toThrow();
    await supervisor.stopProfile('test');
    expect((await locks.checkRuntimeLock(paths.profileLockFile)).locked).toBe(false);
    expect(readAndPrune(paths.userRegistryFile)).toEqual([]);
    expect(warnings.mock.calls.map(args => args.join(' '))).toEqual([
      expect.stringMatching(/supervisor\.lock-release-failed.*kind=profile.*startup profile release failed/),
    ]);
  } finally {
    await supervisor.stopProfile('test');
    if ((await locks.checkRuntimeLock(paths.profileLockFile)).locked) await retained?.release();
  }
});

it('shutdown joins a failing startup and confirms its rollback before succeeding', async () => {
  const entered = deferred();
  const release = deferred();
  const failure = new Error('deferred channel startup failed');
  const { supervisor, paths } = await harness(async () => {
    entered.resolve();
    await release.promise;
    throw failure;
  });
  const starting = supervisor.startProfile('test').catch(error => error);
  try {
    await entered.promise;
    let stopped = false;
    const stopping = supervisor.shutdown().then(() => { stopped = true; });
    const duplicate = supervisor.shutdown();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    release.resolve();
    expect(await starting).toBe(failure);
    await Promise.all([stopping, duplicate]);
    expect(supervisor.isOnline('test')).toBe(false);
    expect(readAndPrune(paths.userRegistryFile)).toEqual([]);
    expect((await locks.checkRuntimeLock(paths.profileLockFile)).locked).toBe(false);
    expect((await locks.checkRuntimeLock(paths.appLockFile('fake-start-app'))).locked).toBe(false);
  } finally {
    release.resolve();
    await starting;
    await supervisor.shutdown();
  }
});
