import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_IDLE_PAUSE_CAP_MS } from '../../../src/bot/idle-watchdog';
import { log } from '../../../src/core/logger';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime';
import {
  EFFECTIVE_ADAPTER_TIMING_KEYS,
  effectiveAdapterTimingFields,
  logEffectiveAdapterTiming,
} from '../../../src/runtime/effective-adapter-timing';

afterEach(() => {
  vi.restoreAllMocks();
});

const IDLE_MS = 15 * 60_000;

describe('effectiveAdapterTimingFields', () => {
  it('distinguishes omitted, explicit none, and configured CLI caps from disabled idle', () => {
    expect(effectiveAdapterTimingFields({
      profile: 'cursor',
      agentKind: 'antigravity',
      configPath: '/tmp/config.json',
      printTimeout: undefined,
      idleTimeoutMs: IDLE_MS,
    })).toEqual({
      profile: 'cursor',
      agentKind: 'antigravity',
      configPath: '/tmp/config.json',
      printTimeoutMode: 'omitted',
      idleTimeoutMode: 'configured',
      idleTimeoutMs: IDLE_MS,
      toolGraceMode: 'configured',
      toolGraceMs: TOOL_IDLE_PAUSE_CAP_MS,
    });

    expect(effectiveAdapterTimingFields({
      profile: 'cursor',
      agentKind: 'antigravity',
      configPath: '/tmp/config.json',
      printTimeout: '0s',
      idleTimeoutMs: IDLE_MS,
    })).toEqual({
      profile: 'cursor',
      agentKind: 'antigravity',
      configPath: '/tmp/config.json',
      printTimeoutMode: 'none',
      printTimeout: '0s',
      idleTimeoutMode: 'configured',
      idleTimeoutMs: IDLE_MS,
      toolGraceMode: 'configured',
      toolGraceMs: TOOL_IDLE_PAUSE_CAP_MS,
    });

    expect(effectiveAdapterTimingFields({
      profile: 'cursor',
      agentKind: 'antigravity',
      configPath: '/tmp/config.json',
      printTimeout: '30m',
      idleTimeoutMs: IDLE_MS,
    })).toEqual({
      profile: 'cursor',
      agentKind: 'antigravity',
      configPath: '/tmp/config.json',
      printTimeoutMode: 'configured',
      printTimeout: '30m',
      idleTimeoutMode: 'configured',
      idleTimeoutMs: IDLE_MS,
      toolGraceMode: 'configured',
      toolGraceMs: TOOL_IDLE_PAUSE_CAP_MS,
      cliTimeoutSleep: 'unverified',
    });

    expect(effectiveAdapterTimingFields({
      profile: 'cursor',
      agentKind: 'antigravity',
      configPath: '/tmp/config.json',
      printTimeout: '0',
      idleTimeoutMs: undefined,
    })).toEqual({
      profile: 'cursor',
      agentKind: 'antigravity',
      configPath: '/tmp/config.json',
      printTimeoutMode: 'none',
      printTimeout: '0',
      idleTimeoutMode: 'disabled',
      toolGraceMode: 'disabled',
    });
  });

  it('marks printTimeout unsupported for other agent kinds', () => {
    expect(effectiveAdapterTimingFields({
      profile: 'claude',
      agentKind: 'claude',
      printTimeout: '10m',
      printTimeoutSupported: false,
      idleTimeoutMs: IDLE_MS,
    })).toEqual({
      profile: 'claude',
      agentKind: 'claude',
      printTimeoutMode: 'unsupported',
      idleTimeoutMode: 'configured',
      idleTimeoutMs: IDLE_MS,
      toolGraceMode: 'configured',
      toolGraceMs: TOOL_IDLE_PAUSE_CAP_MS,
    });
  });

  it('does not claim a CLI cap equals per-tool awake grace', () => {
    const fields = effectiveAdapterTimingFields({
      profile: 'cursor',
      agentKind: 'antigravity',
      printTimeout: '60m',
      idleTimeoutMs: IDLE_MS,
    });
    expect(fields.printTimeout).toBe('60m');
    expect(fields.toolGraceMs).toBe(TOOL_IDLE_PAUSE_CAP_MS);
    expect(fields.cliTimeoutSleep).toBe('unverified');
    expect(fields.toolGraceMs).not.toBe(60 * 60_000 + IDLE_MS);
  });
});

describe('logEffectiveAdapterTiming', () => {
  it('logs only the safe allowlist and never prompts, argv, or credentials', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    logEffectiveAdapterTiming('created', {
      profile: 'cursor',
      agentKind: 'antigravity',
      configPath: '/tmp/config.json',
      printTimeout: '10m',
      idleTimeoutMs: IDLE_MS,
      prompt: 'do not log this prompt',
      argv: ['-p', 'secret-prompt', '--print-timeout', '10m'],
      secret: 'app-secret-value',
      appSecret: 'another-secret',
      credentials: { token: 'tok' },
    } as never);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe('adapter');
    expect(info.mock.calls[0]?.[1]).toBe('effective-timing');
    const logged = info.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(Object.keys(logged).sort()).toEqual([...EFFECTIVE_ADAPTER_TIMING_KEYS].filter((key) => key in logged).sort());
    for (const key of Object.keys(logged)) {
      expect(EFFECTIVE_ADAPTER_TIMING_KEYS).toContain(key);
    }
    expect(JSON.stringify(logged)).not.toContain('do not log this prompt');
    expect(JSON.stringify(logged)).not.toContain('secret-prompt');
    expect(JSON.stringify(logged)).not.toContain('app-secret-value');
    expect(JSON.stringify(logged)).not.toContain('another-secret');
    expect(logged).not.toHaveProperty('prompt');
    expect(logged).not.toHaveProperty('argv');
    expect(logged).not.toHaveProperty('secret');
    expect(logged).not.toHaveProperty('appSecret');
    expect(logged).not.toHaveProperty('credentials');
    expect(logged).toMatchObject({
      reason: 'created',
      profile: 'cursor',
      agentKind: 'antigravity',
      printTimeoutMode: 'configured',
      printTimeout: '10m',
    });
  });
});

describe('createRuntimeAgent effective timing log', () => {
  it('logs profile, config path, printTimeout, and idle/tool budgets at construction', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const configPath = join(tmpdir(), 'larkent-08-config.json');
    createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'antigravity',
        accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
        options: { printTimeout: '30m' },
        preferences: { runIdleTimeoutMinutes: 15 },
      }),
      {
        profileDir: join(tmpdir(), 'larkent-08-profile'),
        rootDir: tmpdir(),
        profile: 'cursor',
        configPath,
      },
    );

    const timing = info.mock.calls.filter((call) => call[0] === 'adapter' && call[1] === 'effective-timing');
    expect(timing).toHaveLength(1);
    expect(timing[0]?.[2]).toMatchObject({
      reason: 'created',
      profile: 'cursor',
      agentKind: 'antigravity',
      configPath,
      printTimeoutMode: 'configured',
      printTimeout: '30m',
      idleTimeoutMode: 'configured',
      idleTimeoutMs: IDLE_MS,
      toolGraceMode: 'configured',
      toolGraceMs: TOOL_IDLE_PAUSE_CAP_MS,
      cliTimeoutSleep: 'unverified',
    });
    expect(JSON.stringify(timing[0]?.[2])).not.toContain('${APP_SECRET}');
  });
});
