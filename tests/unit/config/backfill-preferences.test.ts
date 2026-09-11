import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_KINDS } from '../../../src/agent/registry';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
} from '../../../src/config/profile-schema';
import { loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import {
  DEFAULT_BACKFILL_PREFERENCES,
  formatBackfillPreferences,
  getBackfillPreferences,
  getBackfillPruneHorizonMs,
  normalizeBackfillPreferences,
  type BackfillNormalizeWarning,
} from '../../../src/config/schema';
import { log } from '../../../src/core/logger';

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function warningsOf(raw: unknown): { value: ReturnType<typeof getBackfillPreferences>; warnings: BackfillNormalizeWarning[] } {
  const warnings: BackfillNormalizeWarning[] = [];
  const value = normalizeBackfillPreferences(raw, (warning) => warnings.push(warning));
  return { value, warnings };
}

describe('preferences.backfill', () => {
  it('uses spec defaults when the block is absent', () => {
    expect(getBackfillPreferences({ accounts: { app } })).toEqual(DEFAULT_BACKFILL_PREFERENCES);
    expect(getBackfillPreferences({ accounts: { app }, preferences: {} })).toEqual(
      DEFAULT_BACKFILL_PREFERENCES,
    );
    expect(DEFAULT_BACKFILL_PREFERENCES).toEqual({
      enabled: true,
      dryRun: false,
      lookbackMs: 6 * 60 * 60 * 1000,
      minGapMs: 60 * 1000,
      maxChats: 50,
      maxRawPerChat: 200,
      maxMentionsPerChat: 20,
      chats: [],
    });
  });

  it('merges a partial block onto the defaults', () => {
    expect(
      getBackfillPreferences({
        accounts: { app },
        preferences: { backfill: { enabled: false, maxChats: 3 } },
      }),
    ).toEqual({
      ...DEFAULT_BACKFILL_PREFERENCES,
      enabled: false,
      maxChats: 3,
    });
  });

  it('normalizes garbage values and reports a warning per bad field or chat id', () => {
    const { value, warnings } = warningsOf({
      enabled: 'yes',
      dryRun: 1,
      lookbackMs: -1,
      minGapMs: 0,
      maxChats: Number.NaN,
      maxRawPerChat: '200',
      maxMentionsPerChat: Number.POSITIVE_INFINITY,
      chats: ['oc_keep', 'ou_user', 'chat-1', '', 42, 'oc_also'],
    });

    expect(value).toEqual({
      ...DEFAULT_BACKFILL_PREFERENCES,
      chats: ['oc_keep', 'oc_also'],
    });
    expect(warnings).toEqual([
      { event: 'backfill-invalid', field: 'enabled', value: 'yes' },
      { event: 'backfill-invalid', field: 'dryRun', value: 1 },
      { event: 'backfill-invalid', field: 'lookbackMs', value: -1 },
      { event: 'backfill-invalid', field: 'minGapMs', value: 0 },
      { event: 'backfill-invalid', field: 'maxChats', value: Number.NaN },
      { event: 'backfill-invalid', field: 'maxRawPerChat', value: '200' },
      { event: 'backfill-invalid', field: 'maxMentionsPerChat', value: Number.POSITIVE_INFINITY },
      { event: 'backfill-dropped-chat', chatId: 'ou_user' },
      { event: 'backfill-dropped-chat', chatId: 'chat-1' },
      { event: 'backfill-dropped-chat', chatId: '' },
      { event: 'backfill-dropped-chat', value: 42 },
    ]);
  });

  it('treats a non-array chats value as empty and warns', () => {
    const { value, warnings } = warningsOf({ chats: { oc_a: true } });
    expect(value.chats).toEqual([]);
    expect(warnings).toEqual([{ event: 'backfill-invalid', field: 'chats', value: { oc_a: true } }]);
  });

  it('exposes the ledger prune horizon as twice lookbackMs', () => {
    expect(getBackfillPruneHorizonMs({ accounts: { app } })).toBe(
      DEFAULT_BACKFILL_PREFERENCES.lookbackMs * 2,
    );
    expect(
      getBackfillPruneHorizonMs({
        accounts: { app },
        preferences: { backfill: { lookbackMs: 1_000 } },
      }),
    ).toBe(2_000);
  });

  it('formats the effective block on one line for /doctor', () => {
    expect(formatBackfillPreferences(DEFAULT_BACKFILL_PREFERENCES)).toBe(
      'enabled=true dryRun=false lookbackMs=21600000 minGapMs=60000 maxChats=50 maxRawPerChat=200 maxMentionsPerChat=20 chats=all',
    );
    expect(
      formatBackfillPreferences({
        ...DEFAULT_BACKFILL_PREFERENCES,
        enabled: false,
        dryRun: true,
        chats: ['oc_a', 'oc_b'],
      }),
    ).toBe(
      'enabled=false dryRun=true lookbackMs=21600000 minGapMs=60000 maxChats=50 maxRawPerChat=200 maxMentionsPerChat=20 chats=oc_a,oc_b',
    );
  });

  it.each(AGENT_KINDS)('createDefault + getter defaults are identical for %s', (kind) => {
    const cfg = createDefaultProfileConfig({
      agentKind: kind,
      accounts: { app },
      ...(kind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
    });
    expect(cfg.preferences).not.toHaveProperty('backfill');
    expect(getBackfillPreferences(cfg)).toEqual(DEFAULT_BACKFILL_PREFERENCES);
  });

  it('omits a default-equal block on load and save so untouched profiles stay clean', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'bridge-backfill-omit-'));
    roots.push(rootDir);
    const configPath = join(rootDir, 'config.json');
    const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });

    await saveRootConfig(
      {
        schemaVersion: 3,
        activeProfile: 'claude',
        preferences: {},
        profiles: { claude: profile },
      },
      configPath,
    );

    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      profiles: { claude: { preferences: Record<string, unknown> } };
    };
    expect(saved.profiles.claude.preferences).not.toHaveProperty('backfill');

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.claude?.preferences).not.toHaveProperty('backfill');
    expect(getBackfillPreferences(loaded!.profiles.claude!)).toEqual(DEFAULT_BACKFILL_PREFERENCES);
  });

  it('persists a non-default block as the merged object', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'bridge-backfill-keep-'));
    roots.push(rootDir);
    const configPath = join(rootDir, 'config.json');
    const profile = normalizeProfileConfig({
      schemaVersion: 3,
      agent: { kind: 'claude' },
      accounts: { app },
      preferences: { backfill: { dryRun: true, chats: ['oc_one', 'ou_drop'] } },
    });

    expect(profile.preferences.backfill).toEqual({
      ...DEFAULT_BACKFILL_PREFERENCES,
      dryRun: true,
      chats: ['oc_one'],
    });

    await saveRootConfig(
      {
        schemaVersion: 3,
        activeProfile: 'claude',
        preferences: {},
        profiles: { claude: profile },
      },
      configPath,
    );

    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      profiles: { claude: { preferences: { backfill: unknown } } };
    };
    expect(saved.profiles.claude.preferences.backfill).toEqual({
      ...DEFAULT_BACKFILL_PREFERENCES,
      dryRun: true,
      chats: ['oc_one'],
    });

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.claude?.preferences.backfill).toEqual({
      ...DEFAULT_BACKFILL_PREFERENCES,
      dryRun: true,
      chats: ['oc_one'],
    });
  });

  it('logs normalize warnings when a profile is loaded', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    normalizeProfileConfig({
      schemaVersion: 3,
      agent: { kind: 'kimi' },
      accounts: { app },
      preferences: { backfill: { lookbackMs: -5, chats: ['nope'] } },
    });
    expect(warn).toHaveBeenCalledWith(
      'config',
      'backfill-invalid',
      expect.objectContaining({ field: 'lookbackMs', value: -5 }),
    );
    expect(warn).toHaveBeenCalledWith(
      'config',
      'backfill-dropped-chat',
      expect.objectContaining({ chatId: 'nope' }),
    );
  });
});
