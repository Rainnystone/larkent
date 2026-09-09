import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { resolveAppPaths } from '../../../src/config/app-paths';
import * as locks from '../../../src/runtime/locks';
import { Supervisor } from '../../../src/runtime/supervisor';
import { readAndPrune } from '../../../src/runtime/registry';
import { writeVersionExecutable } from '../../helpers/fake-executable';

it.each(['old transferred lock', 'new rollback lock'] as const)('retains and reports a failed release of the %s until stop retries it', async mode => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reconnect-lock-ownership-')));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  const configPath = join(root, 'config.json');
  const binary = await writeVersionExecutable(root, 'fake-claude', '1.0.0');
  const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'old-app', secret: 'fake-secret', tenant: 'feishu' } } });
  profile.agent.binaryPath = binary;
  const config = createRootConfig('test', profile);
  config.profiles.other = { ...profile, accounts: { app: { ...profile.accounts.app, id: 'other-app' } } };
  await saveRootConfig(config, configPath);
  const failedTarget = mode === 'old transferred lock' ? 'old-app' : 'new-app';
  const releaseFailure = new Error(`${failedTarget} release failed`);
  const connectFailure = new Error('new bridge connection failed');
  const originalAcquire = locks.acquireAppRuntimeLock;
  let originalRelease: (() => Promise<void>) | undefined;
  let attempts = 0;
  vi.spyOn(locks, 'acquireAppRuntimeLock').mockImplementation(async (...args) => {
    const lock = await originalAcquire(...args);
    if (args[1] !== failedTarget) return lock;
    originalRelease = lock.release;
    return { ...lock, release: async () => {
      if (++attempts === 1) throw releaseFailure;
      await lock.release();
    } };
  });
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const connected = new Set<string>();
  const supervisor = new Supervisor({ configPath, rootDir: root, runPreflight: false,
    startChannelFn: async input => {
      const appId = input.cfg.accounts.app.id;
      if (appId === 'new-app' && mode === 'new rollback lock') throw connectFailure;
      connected.add(appId);
      return { channel: { botIdentity: { name: appId } }, disconnect: async () => { connected.delete(appId); } } as never;
    },
  });
  try {
    await supervisor.startProfile('test');
    await supervisor.startProfile('other');
    const next = (await loadRootConfig(configPath))!;
    next.profiles.test!.accounts.app.id = 'new-app';
    await saveRootConfig(next, configPath);
    const error = await supervisor.restartProfile('test').catch(reason => reason);
    if (mode === 'old transferred lock') expect(error).toBe(releaseFailure);
    else expect(error).toMatchObject({ errors: [connectFailure, releaseFailure] });
    expect((await locks.checkRuntimeLock(paths.appLockFile(failedTarget))).locked).toBe(true);
    expect(supervisor.list().find(status => status.profile === 'test')?.appId).toBe(mode === 'old transferred lock' ? 'new-app' : 'old-app');
    expect(connected).toEqual(new Set([mode === 'old transferred lock' ? 'new-app' : 'old-app', 'other-app']));
    await expect(supervisor.restartProfile('test')).rejects.toBe(error);
    await supervisor.stopProfile('test');
    expect(attempts).toBe(2);
    expect((await locks.checkRuntimeLock(paths.appLockFile('old-app'))).locked).toBe(false);
    expect((await locks.checkRuntimeLock(paths.appLockFile('new-app'))).locked).toBe(false);
    expect((await locks.checkRuntimeLock(paths.profileLockFile)).locked).toBe(false);
    expect(supervisor.isOnline('test')).toBe(false);
    expect(supervisor.isOnline('other')).toBe(true);
    expect(connected).toEqual(new Set(['other-app']));
    expect(readAndPrune(paths.userRegistryFile).map(entry => entry.profileName)).toEqual(['other']);
    await supervisor.shutdown();
    expect(connected.size).toBe(0);
    expect(readAndPrune(paths.userRegistryFile)).toEqual([]);
    expect(warnings.mock.calls.map(args => args.join(' '))).toEqual([
      expect.stringMatching(new RegExp(`supervisor\\.lock-release-failed.*kind=app.*${failedTarget} release failed`)),
    ]);
  } finally {
    await supervisor.shutdown();
    if ((await locks.checkRuntimeLock(paths.appLockFile(failedTarget))).locked) await originalRelease?.();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
