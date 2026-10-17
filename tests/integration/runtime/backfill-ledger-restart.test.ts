import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { StartChannelDeps } from '../../../src/bot/channel';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { acquireAppRuntimeLock } from '../../../src/runtime/locks';
import { Supervisor } from '../../../src/runtime/supervisor';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('reuses one supervisor-owned ledger across controls.restart() so two bridges share one file writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-supervisor-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  await mkdir(paths.profileDir, { recursive: true });
  const binary = await writeVersionExecutable(root, 'fake-claude', '1.0.0');
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_ledger', secret: 'secret', tenant: 'feishu' } },
  });
  profile.agent.binaryPath = binary;
  await saveRootConfig(createRootConfig('test', profile), paths.configFile);

  const seen: StartChannelDeps['ledger'][] = [];
  const supervisor = new Supervisor({
    configPath: paths.configFile,
    rootDir: root,
    runPreflight: false,
    startChannelFn: async (deps) => {
      seen.push(deps.ledger);
      return {
        channel: { botIdentity: { name: 'ledger-bot' } },
        disconnect: async () => {},
      } as never;
    },
  });
  cleanups.push(() => supervisor.shutdown());

  await supervisor.startProfile('test');
  await supervisor.restartProfile('test');

  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(seen[1]);
  expect(seen[0]).toBeDefined();
  expect(paths.backfillStateFile).toBe(join(paths.profileDir, 'backfill-state.json'));
});

it('calls recoverMissed on the new bridge after the old disconnect finishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-handoff-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  await mkdir(paths.profileDir, { recursive: true });
  const binary = await writeVersionExecutable(root, 'fake-claude', '1.0.0');
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_ledger', secret: 'secret', tenant: 'feishu' } },
  });
  profile.agent.binaryPath = binary;
  await saveRootConfig(createRootConfig('test', profile), paths.configFile);

  const recoveries: Array<ReturnType<typeof vi.fn>> = [];
  let disconnects = 0;
  const supervisor = new Supervisor({
    configPath: paths.configFile,
    rootDir: root,
    runPreflight: false,
    startChannelFn: async () => {
      const recoverMissed = vi.fn();
      recoveries.push(recoverMissed);
      return {
        channel: { botIdentity: { name: 'ledger-bot' } },
        disconnect: async () => {
          disconnects += 1;
        },
        recoverMissed,
      } as never;
    },
  });
  cleanups.push(() => supervisor.shutdown());

  await supervisor.startProfile('test');
  await supervisor.restartProfile('test');

  expect(disconnects).toBe(1);
  expect(recoveries).toHaveLength(2);
  expect(recoveries[0]).not.toHaveBeenCalled();
  expect(recoveries[1]).toHaveBeenCalledTimes(1);
});

it('keeps the swapped bridge and new app lock when recoverMissed rejects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-handoff-split-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  await mkdir(paths.profileDir, { recursive: true });
  const binary = await writeVersionExecutable(root, 'fake-claude', '1.0.0');
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_ledger_a', secret: 'secret', tenant: 'feishu' } },
  });
  profile.agent.binaryPath = binary;
  await saveRootConfig(createRootConfig('test', profile), paths.configFile);

  let started = 0;
  const startedApps: string[] = [];
  const supervisor = new Supervisor({
    configPath: paths.configFile,
    rootDir: root,
    runPreflight: false,
    startChannelFn: async (deps) => {
      started += 1;
      startedApps.push(deps.cfg.accounts.app.id);
      return {
        channel: { botIdentity: { name: `bot-${deps.cfg.accounts.app.id}` } },
        disconnect: async () => {},
        recoverMissed: started === 2
          ? async () => {
            throw new Error('journal persist failed');
          }
          : async () => {},
      } as never;
    },
  });
  cleanups.push(() => supervisor.shutdown());

  await supervisor.startProfile('test');
  profile.accounts.app.id = 'cli_ledger_b';
  await saveRootConfig(createRootConfig('test', profile), paths.configFile);
  await expect(supervisor.restartProfile('test')).rejects.toThrow('journal persist failed');

  expect(startedApps).toEqual(['cli_ledger_a', 'cli_ledger_b']);
  expect(supervisor.controlsFor('test')?.cfg.accounts.app.id).toBe('cli_ledger_b');
  expect(supervisor.isOnline('test')).toBe(true);

  await expect(
    acquireAppRuntimeLock(paths, 'cli_ledger_b', 'claude'),
  ).rejects.toThrow(/already held/);
  const oldLock = await acquireAppRuntimeLock(paths, 'cli_ledger_a', 'claude');
  await oldLock.release();
});

it('fails reconnect when recoverMissed rejects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-handoff-reject-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  await mkdir(paths.profileDir, { recursive: true });
  const binary = await writeVersionExecutable(root, 'fake-claude', '1.0.0');
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_ledger', secret: 'secret', tenant: 'feishu' } },
  });
  profile.agent.binaryPath = binary;
  await saveRootConfig(createRootConfig('test', profile), paths.configFile);

  let started = 0;
  const supervisor = new Supervisor({
    configPath: paths.configFile,
    rootDir: root,
    runPreflight: false,
    startChannelFn: async () => {
      started += 1;
      return {
        channel: { botIdentity: { name: 'ledger-bot' } },
        disconnect: async () => {},
        recoverMissed: started === 2
          ? async () => {
            throw new Error('journal persist failed');
          }
          : async () => {},
      } as never;
    },
  });
  cleanups.push(() => supervisor.shutdown());

  await supervisor.startProfile('test');
  await expect(supervisor.restartProfile('test')).rejects.toThrow('journal persist failed');
});
