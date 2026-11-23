import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import type { KeepAwake, KeepAwakeHandle } from '../../../src/platform/keep-awake';
import { Supervisor, type SupervisorOptions } from '../../../src/runtime/supervisor';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function fakeKeepAwake() {
  const counts = { acquires: 0, releases: 0 };
  const handle: KeepAwakeHandle = { release: async () => { counts.releases++; } };
  const keepAwake: KeepAwake = { acquire: async () => { counts.acquires++; return handle; } };
  return { counts, handle, keepAwake };
}

async function harness(opts: {
  keepAwake?: KeepAwake;
  enabled?: boolean;
  startChannelFn?: SupervisorOptions['startChannelFn'];
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'supervisor-keep-awake-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  const profile = createDefaultProfileConfig({
    agentKind: 'claude', accounts: { app: { id: 'fake-keep-awake-app', secret: 'fake-secret', tenant: 'feishu' } },
  });
  profile.keepAwake = { enabled: opts.enabled === true };
  await saveRootConfig(createRootConfig('test', profile), configPath);
  const supervisor = new Supervisor({
    configPath,
    rootDir: root,
    runPreflight: false,
    startChannelFn: opts.startChannelFn ?? (async () => ({ channel: { botIdentity: { name: 'fake' } }, disconnect: async () => {} }) as never),
    ...(opts.keepAwake ? { keepAwake: opts.keepAwake } : {}),
  });
  cleanups.push(() => supervisor.shutdown());
  return { supervisor };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('leaves the keep-awake holder alone unless the profile opts in', async () => {
  const { counts, keepAwake } = fakeKeepAwake();
  const { supervisor } = await harness({ keepAwake });

  await supervisor.startProfile('test');
  await supervisor.stopProfile('test');

  expect(counts).toEqual({ acquires: 0, releases: 0 });
});

it('holds while an opted-in profile is online and releases it on stop', async () => {
  const { counts, keepAwake } = fakeKeepAwake();
  const { supervisor } = await harness({ keepAwake, enabled: true });

  await supervisor.startProfile('test');
  expect(supervisor.isOnline('test')).toBe(true);
  await supervisor.stopProfile('test');
  expect(counts).toEqual({ acquires: 1, releases: 1 });

  await supervisor.startProfile('test');
  await supervisor.stopProfile('test');
  expect(counts).toEqual({ acquires: 2, releases: 2 });
});

it('releases the held request on shutdown', async () => {
  const { counts, keepAwake } = fakeKeepAwake();
  const { supervisor } = await harness({ keepAwake, enabled: true });

  await supervisor.startProfile('test');
  await supervisor.shutdown();

  expect(counts).toEqual({ acquires: 1, releases: 1 });
});

it('stays online when the host offers no holder', async () => {
  const { counts, keepAwake } = fakeKeepAwake();
  keepAwake.acquire = async () => { counts.acquires++; return undefined; };
  const { supervisor } = await harness({ keepAwake, enabled: true });

  await supervisor.startProfile('test');
  expect(supervisor.isOnline('test')).toBe(true);
  await supervisor.stopProfile('test');

  expect(counts).toEqual({ acquires: 1, releases: 0 });
});

it('goes online without waiting for the holder, and a stop waits for it and releases it', async () => {
  const started = deferred<KeepAwakeHandle>();
  const { counts, keepAwake } = fakeKeepAwake();
  keepAwake.acquire = async () => { counts.acquires++; return started.promise; };
  const { supervisor } = await harness({ keepAwake, enabled: true });

  await supervisor.startProfile('test');
  expect(supervisor.isOnline('test')).toBe(true);
  expect(counts.acquires).toBe(1);

  let stopped = false;
  const stopping = supervisor.stopProfile('test').then(() => { stopped = true; });
  await tick();
  expect(stopped).toBe(false);

  started.resolve({ release: async () => { counts.releases++; } });
  await stopping;
  expect(counts).toEqual({ acquires: 1, releases: 1 });
});

it('does not ask for a profile whose startup rolls back', async () => {
  const failure = new Error('channel startup failed');
  const { counts, keepAwake } = fakeKeepAwake();
  const { supervisor } = await harness({
    keepAwake,
    enabled: true,
    startChannelFn: async () => { throw failure; },
  });

  await expect(supervisor.startProfile('test')).rejects.toBe(failure);

  expect(counts).toEqual({ acquires: 0, releases: 0 });
});
