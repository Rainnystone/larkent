import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig, type AgentKind, type RootConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  markPermissionDefaultsMigration,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { Supervisor } from '../../../src/runtime/supervisor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';

const roots: string[] = [];
const started: string[] = [];
const disconnected: string[] = [];
let root: string;
let sup: Supervisor;

function app(id: string) {
  return { id, secret: '${APP_SECRET}', tenant: 'feishu' as const };
}

// Stub startChannel — no network, records lifecycle, returns a minimal bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubStartChannel: any = async (deps: any) => {
  started.push(deps.appPaths.profile);
  return {
    channel: { botIdentity: { name: `bot-${deps.appPaths.profile}` } },
    disconnect: async () => {
      disconnected.push(deps.appPaths.profile);
    },
  };
};

beforeEach(async () => {
  started.length = 0;
  disconnected.length = 0;
  root = await mkdtemp(join(tmpdir(), 'bridge-sup-'));
  roots.push(root);
  const configPath = join(root, 'config.json');

  // claude (cli_a), work (cli_b), dup (cli_b — same app as work),
  // kimi/grok for the mixed-kind host test. First-run persists stay in the hook.
  const rc = createRootConfig('claude', await materializeProfile(root, 'claude', 'cli_a'));
  for (const [name, id, kind] of [
    ['work', 'cli_b', 'claude'],
    ['dup', 'cli_b', 'claude'],
    ['kimi', 'cli_kimi', 'kimi'],
    ['grok', 'cli_grok', 'grok'],
  ] as const) {
    rc.profiles[name] = await materializeProfile(root, name, id, kind);
  }
  await saveRootConfig(withPermissionDefaults(rc), configPath);

  sup = new Supervisor({ configPath, rootDir: root, runPreflight: false, startChannelFn: stubStartChannel });
});

afterEach(async () => {
  await sup.shutdown();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('Supervisor', () => {
  it('starts a profile in-process and lists it online', async () => {
    await sup.startProfile('claude');
    expect(sup.isOnline('claude')).toBe(true);
    expect(started).toContain('claude');
    const list = sup.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ profile: 'claude', online: true, pid: process.pid, botName: 'bot-claude' });
  });

  it('hosts multiple profiles at once', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    expect(sup.list().map((s) => s.profile).sort()).toEqual(['claude', 'work']);
  });

  it('hosts two profiles of different agent kinds at once', async () => {
    await sup.startProfile('kimi');
    await sup.startProfile('grok');
    expect(sup.isOnline('kimi')).toBe(true);
    expect(sup.isOnline('grok')).toBe(true);
    expect(started).toEqual(expect.arrayContaining(['kimi', 'grok']));
  });

  it('stops one profile without affecting others or the process', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    await sup.stopProfile('claude');
    expect(sup.isOnline('claude')).toBe(false);
    expect(disconnected).toContain('claude');
    expect(sup.isOnline('work')).toBe(true); // supervisor + other profile still up
  });

  it('refuses to bring up two profiles sharing one app id', async () => {
    await sup.startProfile('work'); // cli_b
    await expect(sup.startProfile('dup')).rejects.toThrow(/已被 profile/);
    expect(sup.isOnline('dup')).toBe(false);
  });

  it('startProfile is idempotent', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('claude');
    expect(started.filter((p) => p === 'claude')).toHaveLength(1);
  });
});

function withPermissionDefaults(rootConfig: RootConfig): RootConfig {
  return Object.keys(rootConfig.profiles).reduce(
    (next, name) => markPermissionDefaultsMigration(next, name),
    rootConfig,
  );
}

/**
 * Finish first-run persists in the hook (workspace default, permission
 * marker, empty session/workspace docs). Two startProfiles on Windows
 * AV-retry writes otherwise race vitest's 5s default.
 */
async function materializeProfile(
  rootDir: string,
  name: string,
  appId: string,
  agentKind: AgentKind = 'claude',
) {
  const paths = resolveAppPaths({ rootDir, profile: name });
  await mkdir(paths.profileDir, { recursive: true });
  await mkdir(paths.defaultWorkspaceDir, { recursive: true });
  await Promise.all([
    new SessionStore(paths.sessionsFile).load(),
    new WorkspaceStore(paths.workspacesFile).load(),
  ]);
  const profile = createDefaultProfileConfig({
    agentKind,
    accounts: { app: app(appId) },
  });
  profile.workspaces.default = paths.defaultWorkspaceDir;
  return profile;
}
