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
  const setEnabled = async (enabled: boolean) => {
    const profile = createDefaultProfileConfig({
      agentKind: 'claude', accounts: { app: { id: 'fake-keep-awake-app', secret: 'fake-secret', tenant: 'feishu' } },
    });
    profile.keepAwake = { enabled };
    await saveRootConfig(createRootConfig('test', profile), configPath);
  };
  await setEnabled(opts.enabled === true);
  const supervisor = new Supervisor({
    configPath,
    rootDir: root,
    runPreflight: false,
    startChannelFn: opts.startChannelFn ?? (async () => ({ channel: { botIdentity: { name: 'fake' } }, disconnect: async () => {} }) as never),
    ...(opts.keepAwake ? { keepAwake: opts.keepAwake } : {}),
  });
  cleanups.push(() => supervisor.shutdown());
  return { supervisor, setEnabled };
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

it('keeps the held request across a reconnect that leaves the switch on', async () => {
  const { counts, keepAwake } = fakeKeepAwake();
  const { supervisor } = await harness({ keepAwake, enabled: true });

  await supervisor.startProfile('test');
  await supervisor.restartProfile('test');
  expect(supervisor.isOnline('test')).toBe(true);
  expect(counts).toEqual({ acquires: 1, releases: 0 });

  await supervisor.stopProfile('test');
  expect(counts).toEqual({ acquires: 1, releases: 1 });
});

// A reconnect re-reads the profile from disk and applies it, so the keep-awake
// switch has to follow the rest of the configuration instead of waiting for a
// full process restart.
it('applies a keep-awake switch change on reconnect', async () => {
  const { counts, keepAwake } = fakeKeepAwake();
  const { supervisor, setEnabled } = await harness({ keepAwake, enabled: true });

  await supervisor.startProfile('test');
  await setEnabled(false);
  await supervisor.restartProfile('test');
  expect(supervisor.isOnline('test')).toBe(true);
  await vi.waitFor(() => expect(counts).toEqual({ acquires: 1, releases: 1 }));

  await setEnabled(true);
  await supervisor.restartProfile('test');
  await vi.waitFor(() => expect(counts.acquires).toBe(2));
  expect(counts.releases).toBe(1);

  await supervisor.stopProfile('test');
  expect(counts).toEqual({ acquires: 2, releases: 2 });
});

// `acquire` and `release` promise never to throw. A source that breaks that
// promise must not fail the profile's own start, stop or later restart.
it('keeps the profile lifecycle intact when the keep-awake source throws', async () => {
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = new Error('keep-awake source failed');
  const { counts, keepAwake } = fakeKeepAwake();
  keepAwake.acquire = async () => { counts.acquires++; throw failure; };
  const { supervisor } = await harness({ keepAwake, enabled: true });

  await supervisor.startProfile('test');
  expect(supervisor.isOnline('test')).toBe(true);
  await supervisor.stopProfile('test');
  expect(supervisor.list()).toEqual([]);

  keepAwake.acquire = async () => {
    counts.acquires++;
    return { release: async () => { counts.releases++; throw failure; } };
  };
  await supervisor.startProfile('test');
  await supervisor.stopProfile('test');
  expect(supervisor.list()).toEqual([]);
  await supervisor.startProfile('test');
  expect(supervisor.isOnline('test')).toBe(true);
  await supervisor.shutdown();

  const keepAwakeWarnings = () => warnings.mock.calls
    .map(args => args.join(' '))
    .filter(line => line.includes('keep-awake.'));
  expect(keepAwakeWarnings()).toEqual([
    expect.stringMatching(/keep-awake\.acquire-failed/),
    expect.stringMatching(/keep-awake\.release-failed/),
    expect.stringMatching(/keep-awake\.release-failed/),
  ]);
});
