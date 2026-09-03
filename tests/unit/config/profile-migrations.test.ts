import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROFILE_SCHEMA_VERSION,
  upgradeProfileRecord,
  upgradeRootConfigDocument,
} from '../../../src/config/migrations.js';
import { normalizeProfileConfig } from '../../../src/config/profile-schema.js';
import { loadRootConfig, loadRootConfigWithMeta, saveRootConfig } from '../../../src/config/profile-store.js';
import { createRuntimeAgent, resolveProfileBinary } from '../../../src/runtime/agent-runtime.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';
import { adapterDisplayName } from '../../helpers/scripted-jsonl-cli.js';

const fixtureRoot = join(process.cwd(), 'tests/fixtures/profiles');
const roots: string[] = [];

afterEach(async () => {
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

    expect(resolveProfileBinary(left)).toBe(leftBin);
    expect(resolveProfileBinary(right)).toBe(rightBin);

    const leftAgent = createRuntimeAgent(left, { profileDir: join(dir, 'left') });
    const rightAgent = createRuntimeAgent(right, { profileDir: join(dir, 'right') });
    expect(leftAgent.id).toBe('cursor');
    expect(rightAgent.displayName).toBe(adapterDisplayName('cursor'));
    await expect(leftAgent.isAvailable()).resolves.toBe(true);
    await expect(rightAgent.isAvailable()).resolves.toBe(true);

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
