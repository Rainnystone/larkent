import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertReconnectAgentKindUnchanged,
  createRuntimeAgent,
  parkWithShutdown,
} from '../../../src/cli/commands/start.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { createRuntimeProfileConfig } from '../../../src/runtime/profile-runtime.js';
import { resolveAppPaths } from '../../../src/config/app-paths.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import * as locks from '../../../src/runtime/locks.js';
import { readAndPrune } from '../../../src/runtime/registry.js';
import { Supervisor } from '../../../src/runtime/supervisor.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';

describe('start runtime agent factory', () => {
  it('keeps Claude as the default runtime agent', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: appAccount(),
      }),
      { profileDir: tmpdir() },
    );

    expect(agent.id).toBe('claude');
    expect(agent.displayName).toBe('Claude Code');
  });

  it('creates CodexAdapter from canonical workspace permissions', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: appAccount(),
      codex: codexConfig(),
      permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    });
    const agent = createRuntimeAgent(profile, {
      profileDir: '/tmp/lark-channel-bridge/profiles/codex-e2e',
    });

    expect(agent.id).toBe('codex');
    expect(agent.displayName).toBe('Codex CLI');
    expect(profile.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(profile.sandbox).toMatchObject({
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    });
  });

  it('creates a Codex runtime agent when an older profile has only a binary path', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: appAccount(),
        codex: { binaryPath: '/usr/local/bin/codex' },
      }),
      { profileDir: '/tmp/lark-channel-bridge/profiles/codex-e2e' },
    );

    expect(agent.id).toBe('codex');
    expect(agent.displayName).toBe('Codex CLI');
  });

  it('seeds a default Codex binary when bootstrapping a new Codex profile', () => {
    const profile = createRuntimeProfileConfig({
      agentKind: 'codex',
      accounts: appAccount(),
    });

    expect(profile.codex?.binaryPath).toBe('codex');
  });

  it('updates the process registry before releasing the old app lock during reconnect', async () => {
    const h = await supervisorHarness();
    const registryAtRelease: string[][] = [];
    const acquire = locks.acquireAppRuntimeLock;
    vi.spyOn(locks, 'acquireAppRuntimeLock').mockImplementation(async (...args) => {
      const lock = await acquire(...args);
      if (args[1] !== 'cli_xxx') return lock;
      return { ...lock, release: async () => {
        registryAtRelease.push(readAndPrune(h.paths.userRegistryFile).map(entry => entry.appId));
        await lock.release();
      } };
    });
    try {
      await h.supervisor.startProfile('test');
      h.config.profiles.test!.accounts.app.id = 'cli_new';
      await saveRootConfig(h.config, h.paths.configFile);
      await h.supervisor.restartProfile('test');
      expect(registryAtRelease).toEqual([['cli_new']]);
      expect((await locks.checkRuntimeLock(h.paths.appLockFile('cli_xxx'))).locked).toBe(false);
      expect((await locks.checkRuntimeLock(h.paths.appLockFile('cli_new'))).locked).toBe(true);
      await h.supervisor.shutdown();
      expect((await locks.checkRuntimeLock(h.paths.appLockFile('cli_new'))).locked).toBe(false);
      expect((await locks.checkRuntimeLock(h.paths.profileLockFile)).locked).toBe(false);
    } finally {
      await h.supervisor.shutdown();
      vi.restoreAllMocks();
      await rm(h.root, { recursive: true, force: true });
    }
  });

  it('shuts down the supervisor (releasing profile locks) before exiting', async () => {
    const h = await supervisorHarness();
    let allowRelease!: () => void;
    let releaseStarted!: () => void;
    const releaseGate = new Promise<void>(resolve => { allowRelease = resolve; });
    const releasing = new Promise<void>(resolve => { releaseStarted = resolve; });
    let appLockReleased = false;
    const acquire = locks.acquireAppRuntimeLock;
    vi.spyOn(locks, 'acquireAppRuntimeLock').mockImplementation(async (...args) => {
      const lock = await acquire(...args);
      return { ...lock, release: async () => {
        releaseStarted();
        await releaseGate;
        await lock.release();
        appLockReleased = true;
      } };
    });
    const hooks = new Map<string, () => void>();
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      hooks.set(String(event), listener);
      return process;
    });
    const exits: unknown[] = [];
    vi.spyOn(process, 'exit').mockImplementation(code => {
      exits.push({ code, appLockReleased, online: h.supervisor.isOnline('test') });
      return undefined as never;
    });
    try {
      await h.supervisor.startProfile('test');
      void parkWithShutdown(h.supervisor, h.paths, undefined, undefined);
      hooks.get('SIGTERM')!();
      await releasing;
      expect(exits).toEqual([]);
      expect((await locks.checkRuntimeLock(h.paths.appLockFile('cli_xxx'))).locked).toBe(true);
      allowRelease();
      await vi.waitFor(() => expect(exits).toEqual([{ code: 0, appLockReleased: true, online: false }]));
      expect((await locks.checkRuntimeLock(h.paths.appLockFile('cli_xxx'))).locked).toBe(false);
      expect((await locks.checkRuntimeLock(h.paths.profileLockFile)).locked).toBe(false);
      expect(readAndPrune(h.paths.userRegistryFile)).toEqual([]);
    } finally {
      allowRelease();
      await h.supervisor.shutdown();
      vi.restoreAllMocks();
      await rm(h.root, { recursive: true, force: true });
    }
  });

  it('rejects reconnect when a profile changes agent kind in place', () => {
    expect(() => assertReconnectAgentKindUnchanged('claude', 'codex')).toThrow(/agent kind/i);
    expect(() => assertReconnectAgentKindUnchanged('codex', 'codex')).not.toThrow();
  });

  it('creates a Cursor adapter without pinning cursor-agent when LARK_CHANNEL_CURSOR_BIN is unset', () => {
    const prev = process.env.LARK_CHANNEL_CURSOR_BIN;
    delete process.env.LARK_CHANNEL_CURSOR_BIN;
    try {
      const agent = createRuntimeAgent(
        createDefaultProfileConfig({
          agentKind: 'cursor',
          accounts: appAccount(),
        }),
        { profileDir: tmpdir() },
      );
      expect(agent.id).toBe('cursor');
      expect(agent.displayName).toBe('Cursor CLI');
    } finally {
      if (prev === undefined) delete process.env.LARK_CHANNEL_CURSOR_BIN;
      else process.env.LARK_CHANNEL_CURSOR_BIN = prev;
    }
  });
});

async function supervisorHarness() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'start-agent-factory-')));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: appAccount() });
  profile.agent.binaryPath = await writeVersionExecutable(root, 'fake-claude', '1.0.0');
  const config = createRootConfig('test', profile);
  await saveRootConfig(config, paths.configFile);
  const supervisor = new Supervisor({ configPath: paths.configFile, rootDir: root, runPreflight: false,
    startChannelFn: async () => ({ channel: {}, disconnect: async () => {} }) as never,
  });
  return { root, paths, config, supervisor };
}

function appAccount() {
  return {
    app: {
      id: 'cli_xxx',
      secret: '${APP_SECRET}',
      tenant: 'feishu' as const,
    },
  };
}

function codexConfig() {
  return {
    binaryPath: '/usr/local/bin/codex',
    realpath: '/usr/local/bin/codex',
    version: 'codex 1.2.3',
    sha256: '0'.repeat(64),
    owner: 501,
    mode: 0o755,
  };
}
