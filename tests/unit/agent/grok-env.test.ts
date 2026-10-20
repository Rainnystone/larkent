import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { AntigravityAdapter } from '../../../src/agent/antigravity/adapter';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import { CursorAdapter } from '../../../src/agent/cursor/adapter';
import { GrokAdapter } from '../../../src/agent/grok/adapter';
import { KimiAdapter } from '../../../src/agent/kimi/adapter';
import { buildLarkChannelEnv } from '../../../src/agent/lark-channel-env';
import type { AgentAdapter, AgentRun } from '../../../src/agent/types';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

function spawnedEnv(): NodeJS.ProcessEnv {
  const options = spawnMock.spawnProcess.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
  return options?.env ?? {};
}

function keysNamed(env: NodeJS.ProcessEnv, name: string): string[] {
  return Object.keys(env).filter((key) => key.toLowerCase() === name.toLowerCase());
}

describe('Grok adapter environment', () => {
  const tracked = [
    'NO_COLOR',
    'No_Color',
    'FORCE_COLOR',
    'Force_Color',
    'PATH',
    'HOME',
    'AUDIT_SENTINEL',
    'WAKE_WEBHOOK_KEY',
    'WAKE_WEBHOOK_URL',
    'SAND_BOX_AUTH_ID',
    'CLOUD_AGENT_INJECTED_SECRET_NAMES',
    'XAI_API_KEY',
  ] as const;
  const previous = Object.fromEntries(tracked.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    spawnMock.spawnProcess.mockReset();
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    process.env.NO_COLOR = '1';
    process.env.No_Color = '1';
    process.env.FORCE_COLOR = '1';
    process.env.Force_Color = '1';
    process.env.PATH = process.env.PATH || '/usr/bin';
    process.env.HOME = process.env.HOME || '/tmp/home';
    process.env.AUDIT_SENTINEL = 'present';
    process.env.WAKE_WEBHOOK_KEY = 'present';
    process.env.WAKE_WEBHOOK_URL = 'present';
    process.env.SAND_BOX_AUTH_ID = 'present';
    process.env.CLOUD_AGENT_INJECTED_SECRET_NAMES = 'present';
    process.env.XAI_API_KEY = 'present';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('does not pass NO_COLOR or a bridge FORCE_COLOR into the grok process', () => {
    const adapter = new GrokAdapter({
      binary: 'grok',
      larkChannel: { profile: 'default', rootDir: '/tmp/lark-channel-home' },
    });
    adapter.run({
      runId: 'r1',
      prompt: 'hi',
      cwd: '/tmp',
      toolEnv: {
        LARK_BRIDGE_TOOL_ENDPOINT: 'http://127.0.0.1:9',
        LARK_BRIDGE_TOOL_TOKEN: 'tool-token',
        LARK_BRIDGE_TOOL_CLIENT: '/tmp/tool-client.mjs',
      },
    });

    const env = spawnedEnv();
    expect(keysNamed(env, 'NO_COLOR')).toEqual([]);
    expect(keysNamed(env, 'FORCE_COLOR')).toEqual([]);
    expect(env.LARK_CHANNEL).toBe('1');
    expect(env.LARK_CHANNEL_PROFILE).toBe('default');
    expect(env.LARK_CHANNEL_HOME).toBe('/tmp/lark-channel-home');
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(env.LARK_BRIDGE_TOOL_ENDPOINT).toBe('http://127.0.0.1:9');
    expect(env.LARK_BRIDGE_TOOL_CLIENT).toBe('/tmp/tool-client.mjs');
    expect(env.LARK_BRIDGE_TOOL_TOKEN).toBe('tool-token');
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.XAI_API_KEY).toBe('present');
    for (const name of [
      'AUDIT_SENTINEL',
      'WAKE_WEBHOOK_KEY',
      'WAKE_WEBHOOK_URL',
      'SAND_BOX_AUTH_ID',
      'CLOUD_AGENT_INJECTED_SECRET_NAMES',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it('keeps NO_COLOR=1 for the shared helper and the other CLI adapters', async () => {
    const shared = buildLarkChannelEnv();
    expect(shared.NO_COLOR).toBe('1');
    expect(shared.FORCE_COLOR).toBeUndefined();

    const adapters: AgentAdapter[] = [
      new ClaudeAdapter({ binary: 'claude' }),
      new CodexAdapter({ binary: 'codex', profileStateDir: '/tmp/codex-profile' }),
      new CursorAdapter({ binary: 'cursor-agent' }),
      new AntigravityAdapter({ binary: 'agy' }),
      new KimiAdapter({ binary: 'kimi' }),
    ];
    for (const adapter of adapters) {
      const child = fakeChild();
      spawnMock.spawnProcess.mockReturnValue(child);
      const run: AgentRun = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
      try {
        const env = spawnedEnv();
        expect(env.NO_COLOR, adapter.id).toBe('1');
        expect(keysNamed(env, 'FORCE_COLOR'), adapter.id).toEqual([]);
        expect(env.AUDIT_SENTINEL, adapter.id).toBeUndefined();
        expect(env.WAKE_WEBHOOK_KEY, adapter.id).toBeUndefined();
        expect(env.SAND_BOX_AUTH_ID, adapter.id).toBeUndefined();
        expect(env.PATH, adapter.id).toBe(process.env.PATH);
        expect(env.HOME, adapter.id).toBe(process.env.HOME);
      } finally {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.stdout.end();
        child.stderr.end();
        await run.waitForExit(1000);
      }
    }
  });
});
