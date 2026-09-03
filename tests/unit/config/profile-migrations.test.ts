import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROFILE_SCHEMA_VERSION, upgradeProfileToCurrent } from '../../../src/config/migrations.js';
import { loadRootConfig } from '../../../src/config/profile-store.js';
import { normalizeProfileConfig } from '../../../src/config/profile-schema.js';

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
  it('leaves agent.binaryPath absent for PATH detection on env-var and PATH v2 profiles', async () => {
    const envPath = await copyFixture('env-var');
    const pathPath = await copyFixture('path-claude');
    const cursorPath = await copyFixture('cursor-versioned-agent');

    const envRoot = await loadRootConfig(envPath, { persistUpgrades: true });
    const pathRoot = await loadRootConfig(pathPath, { persistUpgrades: true });
    const cursorRoot = await loadRootConfig(cursorPath, { persistUpgrades: true });

    expect(envRoot?.profiles.kimi?.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(envRoot?.profiles.kimi?.agent).toEqual({ kind: 'kimi' });
    expect(envRoot?.profiles.kimi?.agent).not.toHaveProperty('binaryPath');
    expect(envRoot?.profiles.grok?.agent).toEqual({ kind: 'grok' });
    expect(envRoot?.profiles.grok?.agent).not.toHaveProperty('binaryPath');

    expect(pathRoot?.profiles.claude?.agent).toEqual({ kind: 'claude' });
    expect(pathRoot?.profiles.claude?.agent).not.toHaveProperty('binaryPath');

    expect(cursorRoot?.profiles.cursor?.agent).toEqual({ kind: 'cursor' });
    expect(cursorRoot?.profiles.cursor?.agent).not.toHaveProperty('binaryPath');
  });

  it('copies an absolute Codex binaryPath onto agent.binaryPath', async () => {
    const dest = await copyFixture('codex-binary-path');
    const root = await loadRootConfig(dest, { persistUpgrades: true });
    expect(root?.profiles.codex?.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(root?.profiles.codex?.agent).toEqual({
      kind: 'codex',
      binaryPath: '/opt/pinned/codex',
    });
    expect(root?.profiles.codex?.codex).toMatchObject({ binaryPath: '/opt/pinned/codex' });
  });

  it('writes v3 back and reloads as a no-op', async () => {
    const dest = await copyFixture('env-var');
    await loadRootConfig(dest, { persistUpgrades: true });
    const afterFirst = await readFile(dest, 'utf8');
    const first = JSON.parse(afterFirst) as {
      profiles: Record<string, { schemaVersion: number; agent?: { binaryPath?: string } }>;
    };
    expect(first.profiles.kimi.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(first.profiles.kimi.agent).not.toHaveProperty('binaryPath');

    await loadRootConfig(dest, { persistUpgrades: true });
    const afterSecond = await readFile(dest, 'utf8');
    expect(afterSecond).toBe(afterFirst);

    const again = upgradeProfileToCurrent(first.profiles.kimi);
    expect(again.changed).toBe(false);
  });

  it('normalizes a v2 object in memory to the current shape', () => {
    const profile = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'kimi',
      accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    });
    expect(profile.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(profile.agent).toEqual({ kind: 'kimi' });
    expect(profile).not.toHaveProperty('binaryPath');
  });

  it('does not relabel nested schemaVersion 1 as v2', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 1,
        agentKind: 'claude',
        accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
      }),
    ).toThrow(/migrateV1ToV2/);
  });

  it('deletes src/agent/cursor/binary.ts so detection uses descriptor.binaryNames', () => {
    expect(existsSync(join(process.cwd(), 'src/agent/cursor/binary.ts'))).toBe(false);
  });
});
