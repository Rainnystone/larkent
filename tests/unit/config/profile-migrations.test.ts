import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROFILE_SCHEMA_VERSION,
  UnsupportedProfileSchemaError,
  upgradeProfileRecord,
  upgradeRootConfigDocument,
} from '../../../src/config/migrations.js';
import { ActiveBridgeMigrationConflictError, migrateV1ToV2 } from '../../../src/config/migrate-v2.js';
import { createBootstrapProfileConfig } from '../../../src/cli/profile-bootstrap.js';
import { normalizeProfileConfig } from '../../../src/config/profile-schema.js';
import { loadRootConfig, loadRootConfigWithMeta, saveRootConfig } from '../../../src/config/profile-store.js';
import { createRuntimeAgent, resolveProfileBinary } from '../../../src/runtime/agent-runtime.js';
import { resolveProfileRuntime } from '../../../src/runtime/profile-runtime.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';
import { adapterDisplayName, withEnvBin, withIsolatedPath } from '../../helpers/scripted-jsonl-cli.js';

const fixtureRoot = join(process.cwd(), 'tests/fixtures/profiles');
const roots: string[] = [];
const childProcesses: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(childProcesses.splice(0).map((child) => killChild(child)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function copyFixture(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `profile-v3-${name}-`));
  roots.push(root);
  const dest = join(root, 'config.json');
  await copyFile(join(fixtureRoot, name, 'config.json'), dest);
  return dest;
}

describe('profile v2 to v3 migrations', () => {
  it('leaves agent.binaryPath absent for PATH detection on env-var, PATH, and Cursor v2 profiles', async () => {
    const envPath = await copyFixture('env-var');
    const pathPath = await copyFixture('path-claude');
    const cursorPath = await copyFixture('cursor-versioned-agent');

    const envRoot = await loadRootConfig(envPath);
    const pathRoot = await loadRootConfig(pathPath);
    const cursorRoot = await loadRootConfig(cursorPath);

    expect(envRoot?.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(envRoot?.profiles.kimi?.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(envRoot?.profiles.kimi?.agent).toEqual({ kind: 'kimi' });
    expect(envRoot?.profiles.kimi?.agent).not.toHaveProperty('binaryPath');
    expect(envRoot?.profiles.grok?.agent).toEqual({ kind: 'grok' });
    expect(envRoot?.profiles.grok?.agent).not.toHaveProperty('binaryPath');

    expect(pathRoot?.profiles.claude?.agent).toEqual({ kind: 'claude' });
    expect(pathRoot?.profiles.claude?.agent).not.toHaveProperty('binaryPath');

    expect(cursorRoot?.profiles.cursor?.agent).toEqual({ kind: 'cursor' });
    expect(cursorRoot?.profiles.cursor?.agent).not.toHaveProperty('binaryPath');

    expect(JSON.parse(await readFile(envPath, 'utf8')).schemaVersion).toBe(2);
    expect(JSON.parse(await readFile(pathPath, 'utf8')).schemaVersion).toBe(2);
    expect(JSON.parse(await readFile(cursorPath, 'utf8')).schemaVersion).toBe(2);
  });

  it('copies an absolute Codex binaryPath onto agent.binaryPath and leaves relative names off agent', async () => {
    const dest = await copyFixture('codex-binary-path');
    const root = await loadRootConfig(dest);
    expect(root?.profiles.codex?.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(root?.profiles.codex?.agent).toEqual({
      kind: 'codex',
      binaryPath: '/opt/pinned/codex',
    });
    expect(root?.profiles.codex?.codex).toMatchObject({ binaryPath: '/opt/pinned/codex' });

    const relative = upgradeProfileRecord({
      schemaVersion: 2,
      agentKind: 'codex',
      accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
      codex: { binaryPath: 'codex', inheritCodexHome: true },
    });
    expect(relative.upgraded).toBe(true);
    expect((relative.document.agent as { binaryPath?: string }).binaryPath).toBeUndefined();
    expect(relative.document.codex).toMatchObject({ binaryPath: 'codex' });
  });

  it('writes v3 back from the loader meta and reloads as a no-op', async () => {
    const dest = await copyFixture('env-var');
    const firstLoad = await loadRootConfigWithMeta(dest);
    expect(firstLoad?.upgraded).toBe(true);
    expect(JSON.parse(await readFile(dest, 'utf8')).schemaVersion).toBe(2);

    await saveRootConfig(firstLoad!.root, dest);
    const afterFirst = await readFile(dest, 'utf8');
    const first = JSON.parse(afterFirst) as {
      schemaVersion: number;
      profiles: Record<string, { schemaVersion: number; agent?: { kind?: string; binaryPath?: string } }>;
    };
    expect(first.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(first.profiles.kimi?.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(first.profiles.kimi?.agent).toEqual({ kind: 'kimi' });
    expect(first.profiles.kimi?.agent).not.toHaveProperty('binaryPath');

    const secondLoad = await loadRootConfigWithMeta(dest);
    expect(secondLoad?.upgraded).toBe(false);
    await saveRootConfig(secondLoad!.root, dest);
    expect(await readFile(dest, 'utf8')).toBe(afterFirst);

    const again = upgradeProfileRecord(first.profiles.kimi);
    expect(again.upgraded).toBe(false);
  });

  it('normalizes a v2 object in memory to the current shape', () => {
    const profile = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'kimi',
      accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    });
    expect(profile.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(profile.agent).toEqual({ kind: 'kimi' });
    expect(profile.agent).not.toHaveProperty('binaryPath');
    expect(profile).not.toHaveProperty('binaryPath');
  });

  it('does not relabel nested schemaVersion 1 as v2 or rewrite unknown versions', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 1,
        agentKind: 'claude',
        accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
      }),
    ).toThrow(/migrateV1ToV2/);

    expect(() =>
      upgradeRootConfigDocument({
        schemaVersion: 4,
        activeProfile: 'claude',
        profiles: {},
      }),
    ).toThrow(/unsupported profile schemaVersion 4/);
    expect(() =>
      upgradeProfileRecord({
        schemaVersion: 4,
        agentKind: 'claude',
        accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
      }),
    ).toThrow(/unsupported profile schemaVersion 4/);
  });

  it('does not persist v3 into committed profile fixtures', async () => {
    const fixture = join(fixtureRoot, 'env-var/config.json');
    const before = await readFile(fixture, 'utf8');
    expect(JSON.parse(before).schemaVersion).toBe(2);
    await loadRootConfig(fixture);
    expect(await readFile(fixture, 'utf8')).toBe(before);
  });

  it('persists v3 from profile-runtime on a tmp copy and reloads as a no-op', async () => {
    const dest = await copyFixture('env-var');
    const raw = JSON.parse(await readFile(dest, 'utf8')) as {
      profiles: Record<string, { accounts?: { app?: { secret?: string } } }>;
    };
    raw.profiles.kimi!.accounts!.app!.secret = '${APP_SECRET}';
    raw.profiles.grok!.accounts!.app!.secret = '${APP_SECRET}';
    await writeFile(dest, `${JSON.stringify(raw, null, 2)}\n`);

    await resolveProfileRuntime({
      config: dest,
      profile: 'kimi',
      allowBootstrap: false,
    });
    const afterFirst = await readFile(dest, 'utf8');
    const persisted = JSON.parse(afterFirst) as {
      schemaVersion: number;
      profiles: Record<string, { schemaVersion: number; agent?: { kind?: string } }>;
    };
    expect(persisted.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(persisted.profiles.kimi?.agent).toEqual({ kind: 'kimi' });

    await resolveProfileRuntime({
      config: dest,
      profile: 'kimi',
      allowBootstrap: false,
    });
    expect(await readFile(dest, 'utf8')).toBe(afterFirst);
  });

  it('skips migrateV1ToV2 for both v2 and v3 roots', async () => {
    const v2Path = await copyFixture('env-var');
    const v2Before = await readFile(v2Path, 'utf8');
    await expect(migrateV1ToV2({
      rootDir: join(v2Path, '..'),
      configFile: v2Path,
      profile: 'kimi',
    })).resolves.toEqual({ migrated: false, profile: 'kimi' });
    expect(await readFile(v2Path, 'utf8')).toBe(v2Before);

    const firstLoad = await loadRootConfigWithMeta(v2Path);
    await saveRootConfig(firstLoad!.root, v2Path);
    const v3Before = await readFile(v2Path, 'utf8');
    await expect(migrateV1ToV2({
      rootDir: join(v2Path, '..'),
      configFile: v2Path,
      profile: 'kimi',
    })).resolves.toEqual({ migrated: false, profile: 'kimi' });
    expect(await readFile(v2Path, 'utf8')).toBe(v3Before);
  });

  it('does not rewrite an unsupported schemaVersion config on load or migrate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profile-unsupported-'));
    roots.push(root);
    const dest = join(root, 'config.json');
    const future = {
      schemaVersion: 4,
      activeProfile: 'kimi',
      profiles: {
        kimi: {
          schemaVersion: 4,
          agentKind: 'kimi',
          agent: { kind: 'kimi', binaryPath: '/keep/me' },
        },
      },
    };
    const payload = `${JSON.stringify(future, null, 2)}\n`;
    await writeFile(dest, payload);

    await expect(loadRootConfig(dest)).rejects.toBeInstanceOf(UnsupportedProfileSchemaError);
    expect(await readFile(dest, 'utf8')).toBe(payload);

    await expect(migrateV1ToV2({ rootDir: root, configFile: dest, profile: 'kimi' })).rejects.toBeInstanceOf(
      UnsupportedProfileSchemaError,
    );
    expect(await readFile(dest, 'utf8')).toBe(payload);

    await expect(
      resolveProfileRuntime({ config: dest, profile: 'kimi', allowBootstrap: false }),
    ).rejects.toBeInstanceOf(UnsupportedProfileSchemaError);
    expect(await readFile(dest, 'utf8')).toBe(payload);
  });

  it('does not persist v3 while another bridge process is registered', async () => {
    const dest = await copyFixture('env-var');
    const rootDir = join(dest, '..');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    childProcesses.push(child);
    if (!child.pid) throw new Error('failed to spawn live process');
    await writeFile(
      join(rootDir, 'processes.json'),
      `${JSON.stringify({
        entries: [
          {
            id: 'live',
            pid: child.pid,
            appId: 'cli_kimi_env',
            tenant: 'feishu',
            profileName: 'kimi',
            agentKind: 'kimi',
            configPath: dest,
            startedAt: new Date().toISOString(),
            version: '0.1.32',
          },
        ],
      }, null, 2)}\n`,
    );
    const before = await readFile(dest, 'utf8');
    await expect(
      resolveProfileRuntime({ config: dest, profile: 'kimi', allowBootstrap: false }),
    ).rejects.toBeInstanceOf(ActiveBridgeMigrationConflictError);
    expect(await readFile(dest, 'utf8')).toBe(before);
    expect(JSON.parse(before).schemaVersion).toBe(2);
  });

  it('pins an env-only non-Codex binary onto a new profile so spawn does not reread the env var', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'profile-env-pin-'));
    roots.push(dir);
    const envBin = await writeVersionExecutable(dir, 'env-kimi', 'kimi 0.0.0-env');
    const accounts = { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' as const } };

    await withEnvBin('kimi', envBin, async () => {
      const profile = await createBootstrapProfileConfig({ agentKind: 'kimi', accounts });
      expect(profile.agent.binaryPath).toBe(envBin);

      await withEnvBin('kimi', join(dir, 'missing-after-pin'), async () => {
        await withIsolatedPath(join(dir, 'empty-path'), async () => {
          const agent = createRuntimeAgent(profile, { profileDir: join(dir, 'kimi') });
          await expect(agent.checkAvailability?.()).resolves.toEqual({
            ok: true,
            version: 'kimi 0.0.0-env',
          });
        });
      });
    });

    const pathOnly = await createBootstrapProfileConfig({ agentKind: 'kimi', accounts });
    expect(pathOnly.agent).toEqual({ kind: 'kimi' });
    expect(pathOnly.agent).not.toHaveProperty('binaryPath');
  });

  it('lets two same-kind profiles spawn distinct binaryPath values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'profile-two-binaries-'));
    roots.push(dir);
    const leftBin = await writeVersionExecutable(dir, 'cursor-left', 'cursor-agent 0.0.0-left');
    const rightBin = await writeVersionExecutable(dir, 'cursor-right', 'cursor-agent 0.0.0-right');
    const accounts = { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' as const } };
    const left = normalizeProfileConfig({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      agent: { kind: 'cursor', binaryPath: leftBin },
      agentKind: 'cursor',
      accounts,
    });
    const right = normalizeProfileConfig({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      agent: { kind: 'cursor', binaryPath: rightBin },
      agentKind: 'cursor',
      accounts,
    });

    expect(left.agentKind).toBe('cursor');
    expect(right.agentKind).toBe('cursor');
    expect(resolveProfileBinary(left)).toBe(leftBin);
    expect(resolveProfileBinary(right)).toBe(rightBin);

    await withEnvBin('cursor', join(dir, 'missing-env-cursor'), async () => {
      await withIsolatedPath(join(dir, 'empty-path'), async () => {
        const leftAgent = createRuntimeAgent(left, { profileDir: join(dir, 'left') });
        const rightAgent = createRuntimeAgent(right, { profileDir: join(dir, 'right') });
        expect(leftAgent.id).toBe('cursor');
        expect(rightAgent.displayName).toBe(adapterDisplayName('cursor'));
        await expect(leftAgent.checkAvailability?.()).resolves.toEqual({
          ok: true,
          version: 'cursor-agent 0.0.0-left',
        });
        await expect(rightAgent.checkAvailability?.()).resolves.toEqual({
          ok: true,
          version: 'cursor-agent 0.0.0-right',
        });
      });
    });

    const missing = normalizeProfileConfig({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      agent: { kind: 'cursor', binaryPath: join(dir, 'missing-cursor') },
      agentKind: 'cursor',
      accounts,
    });
    await expect(createRuntimeAgent(missing, { profileDir: join(dir, 'missing') }).isAvailable()).resolves.toBe(false);
  });

  it('deletes src/agent/cursor/binary.ts so detection uses descriptor.binaryNames', () => {
    expect(existsSync(join(process.cwd(), 'src/agent/cursor/binary.ts'))).toBe(false);
  });
});

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 500);
  });
}
