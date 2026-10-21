import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultProfileConfig,
  DEFAULT_AUTOMATION_TIMEZONE,
  normalizeProfileConfig,
  resolveLocalTimeZone,
} from '../../../src/config/profile-schema';
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

describe('automations profile settings', () => {
  it('reads unset automations as disabled reminders, disabled agent tasks, and the default automation timezone', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.automations).toEqual({
      enabled: false,
      agentTasks: false,
      timezone: DEFAULT_AUTOMATION_TIMEZONE,
    });
  });

  it('keeps optional status endpoint and secret and treats blanks as unset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automations-status-push-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    const profile = normalizeProfileConfig({
      schemaVersion: 3,
      agentKind: 'claude',
      accounts: { app },
      automations: {
        enabled: true,
        statusEndpoint: 'https://status.test',
        statusSecret: 'unit-status-secret',
      },
    });
    expect(profile.automations).toEqual({
      enabled: true,
      agentTasks: false,
      timezone: DEFAULT_AUTOMATION_TIMEZONE,
      statusEndpoint: 'https://status.test',
      statusSecret: 'unit-status-secret',
    });

    await saveRootConfig(createRootConfig('claude', profile), configPath);
    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.claude?.automations).toEqual(profile.automations);

    const blank = normalizeProfileConfig({
      schemaVersion: 3,
      agentKind: 'claude',
      accounts: { app },
      automations: {
        enabled: true,
        statusEndpoint: '  ',
        statusSecret: '',
      },
    });
    expect(blank.automations).toEqual({
      enabled: true,
      agentTasks: false,
      timezone: DEFAULT_AUTOMATION_TIMEZONE,
    });
  });

  it('survives a profile load/save round-trip and keeps explicit values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automations-settings-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    const profile = normalizeProfileConfig({
      schemaVersion: 3,
      agentKind: 'claude',
      accounts: { app },
      automations: {
        enabled: true,
        agentTasks: true,
        timezone: 'America/New_York',
      },
    });

    await saveRootConfig(createRootConfig('claude', profile), configPath);
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      profiles: { claude: { automations: unknown } };
    };
    expect(saved.profiles.claude.automations).toEqual({
      enabled: true,
      agentTasks: true,
      timezone: 'America/New_York',
    });

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.claude?.automations).toEqual({
      enabled: true,
      agentTasks: true,
      timezone: 'America/New_York',
    });
  });

  it('treats truthy-but-not-true flags as off and invalid IANA as the default automation timezone', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 3,
      agentKind: 'claude',
      accounts: { app },
      automations: {
        enabled: 'yes',
        agentTasks: 1,
        timezone: 'Not/AZone',
      },
    });
    expect(cfg.automations).toEqual({
      enabled: false,
      agentTasks: false,
      timezone: DEFAULT_AUTOMATION_TIMEZONE,
    });
  });

  it('does not drop automations when a leftover reliability block is present', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 3,
      agentKind: 'claude',
      accounts: { app },
      reliability: { notice: true },
      automations: { enabled: true, timezone: 'Europe/Berlin' },
    });
    expect(cfg.reliability).toBeUndefined();
    expect(cfg.automations).toEqual({
      enabled: true,
      agentTasks: false,
      timezone: 'Europe/Berlin',
    });
  });
});

describe('resolveLocalTimeZone', () => {
  it('returns the Intl zone, or UTC when resolvedOptions yields an empty or invalid zone', () => {
    expect(resolveLocalTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);

    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    try {
      spy.mockReturnValue({
        locale: 'en-US',
        calendar: 'gregory',
        numberingSystem: 'latn',
        timeZone: '',
      });
      expect(resolveLocalTimeZone()).toBe('UTC');

      spy.mockReturnValue({
        locale: 'en-US',
        calendar: 'gregory',
        numberingSystem: 'latn',
        timeZone: 'Not/AZone',
      });
      expect(resolveLocalTimeZone()).toBe('UTC');
    } finally {
      spy.mockRestore();
    }
  });
});
