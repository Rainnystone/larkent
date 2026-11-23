import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig, normalizeProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('keep-awake profile setting', () => {
  it('reads unset keep-awake as disabled', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.keepAwake).toEqual({ enabled: false });
  });

  it('keeps an explicit opt-in across a save and load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'keep-awake-setting-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    profile.keepAwake = { enabled: true };

    await saveRootConfig(createRootConfig('test', profile), configPath);

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.test?.keepAwake).toEqual({ enabled: true });
  });

  it('falls back to disabled for anything but an explicit true', () => {
    for (const keepAwake of [undefined, null, 'yes', [], { enabled: 'true' }, { enabled: 1 }]) {
      const cfg = normalizeProfileConfig({ schemaVersion: 3, agentKind: 'claude', accounts: { app }, keepAwake });
      expect(cfg.keepAwake).toEqual({ enabled: false });
    }
  });
});
