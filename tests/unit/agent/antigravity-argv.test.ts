import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { prefixBridgeSystemPrompt } from '../../../src/agent/bridge-system-prompt';
import { AntigravityAdapter } from '../../../src/agent/antigravity/adapter';
import { buildAntigravityArgs } from '../../../src/agent/antigravity/argv';
import { log } from '../../../src/core/logger';

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

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

describe('buildAntigravityArgs', () => {
  it('builds a fresh print-mode invocation with stream-json and unattended flags', () => {
    expect(buildAntigravityArgs({ prompt: 'hello' })).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
    ]);
  });

  it('resumes with --conversation and never uses --continue', () => {
    const args = buildAntigravityArgs({
      prompt: 'continue',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      model: 'claude-sonnet-4-6',
    });
    expect(args).toEqual([
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--conversation',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '--model',
      'claude-sonnet-4-6',
    ]);
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--continue');
  });

  it('keeps the prompt as a single argv element even with XML-ish content', () => {
    const prompt = '<bridge_context>{"chatId":"oc_1"}</bridge_context>\n\nhello > world';
    const args = buildAntigravityArgs({ prompt });
    expect(args[1]).toBe(prompt);
  });

  it('rejects restricted sandbox modes instead of silently bypassing permissions', () => {
    expect(() => buildAntigravityArgs({ prompt: 'hi', sandbox: 'read-only' })).toThrow(
      /only supports full access/,
    );
    expect(() => buildAntigravityArgs({ prompt: 'hi', sandbox: 'workspace-write' })).toThrow(
      /only supports full access/,
    );
    expect(() =>
      buildAntigravityArgs({ prompt: 'hi', sandbox: 'danger-full-access' }),
    ).not.toThrow();
  });

  it('refuses restricted sandbox before spawn', () => {
    expect(() =>
      new AntigravityAdapter({ binary: 'unused' }).run({
        runId: 'run-ro',
        prompt: 'hi',
        cwd: tmpdir(),
        sandbox: 'read-only',
      }),
    ).toThrow(/only supports full access/);
  });

  it('appends --print-timeout with the exact configured duration', () => {
    expect(buildAntigravityArgs({ prompt: 'hello', printTimeout: '15m' })).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--print-timeout',
      '15m',
    ]);
  });

  it('omits --print-timeout when unset so agy keeps its own default', () => {
    const args = buildAntigravityArgs({ prompt: 'hello' });
    expect(args).not.toContain('--print-timeout');
    expect(args.join('\0')).not.toContain('10m');
  });

  it.each(['0', '0s'] as const)('forwards explicit no-cap printTimeout %s onto argv', (printTimeout) => {
    expect(buildAntigravityArgs({ prompt: 'hello', printTimeout })).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--print-timeout',
      printTimeout,
    ]);
  });

  it('keeps --conversation and --model when printTimeout is set', () => {
    expect(
      buildAntigravityArgs({
        prompt: 'continue',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        model: 'claude-sonnet-4-6',
        printTimeout: '30s',
      }),
    ).toEqual([
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--conversation',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '--model',
      'claude-sonnet-4-6',
      '--print-timeout',
      '30s',
    ]);
  });

  it('still rejects restricted sandbox when printTimeout is set', () => {
    expect(() =>
      buildAntigravityArgs({ prompt: 'hi', sandbox: 'read-only', printTimeout: '10m' }),
    ).toThrow(/only supports full access/);
    expect(() =>
      new AntigravityAdapter({
        binary: 'unused',
        agentOptions: { printTimeout: '10m' },
      }).run({
        runId: 'run-ro-timeout',
        prompt: 'hi',
        cwd: tmpdir(),
        sandbox: 'read-only',
      }),
    ).toThrow(/only supports full access/);
  });

  it('forwards profile printTimeout onto spawned print-mode argv', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    new AntigravityAdapter({
      binary: '/usr/local/bin/agy',
      agentOptions: { printTimeout: '15m' },
    }).run({
      runId: 'run-print-timeout',
      prompt: 'hi',
      cwd: tmpdir(),
      resumeHandle: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      model: 'claude-sonnet-4-6',
    });
    expect(spawnMock.spawnProcess.mock.calls[0]?.[1]).toEqual([
      '-p',
      prefixBridgeSystemPrompt('hi', undefined),
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--conversation',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '--model',
      'claude-sonnet-4-6',
      '--print-timeout',
      '15m',
    ]);
  });

  it.each(['0', '0s'] as const)('forwards captured no-cap printTimeout %s onto spawned argv', (printTimeout) => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    new AntigravityAdapter({
      binary: '/usr/local/bin/agy',
      agentOptions: { printTimeout },
    }).run({
      runId: `run-print-timeout-${printTimeout}`,
      prompt: 'hi',
      cwd: tmpdir(),
    });
    const argv = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flag = argv.indexOf('--print-timeout');
    expect(flag).toBeGreaterThan(-1);
    expect(argv[flag + 1]).toBe(printTimeout);
  });

  it('keeps the construction-time printTimeout after the source options object is mutated', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    const agentOptions = { printTimeout: '10m' };
    const adapter = new AntigravityAdapter({
      binary: '/usr/local/bin/agy',
      agentOptions,
    });
    agentOptions.printTimeout = '30m';
    adapter.run({
      runId: 'run-print-timeout-snapshot',
      prompt: 'hi',
      cwd: tmpdir(),
    });
    const argv = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flag = argv.indexOf('--print-timeout');
    expect(argv[flag + 1]).toBe('10m');
    expect(argv).not.toContain('30m');
  });

  it('logs captured printTimeout at run start without prompt or argv', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    new AntigravityAdapter({
      binary: '/usr/local/bin/agy',
      agentOptions: { printTimeout: '15m' },
      larkChannel: { profile: 'cursor', configPath: '/tmp/config.json' },
    }).run({
      runId: 'run-print-timeout-log',
      prompt: 'super-secret-user-prompt',
      cwd: tmpdir(),
    });
    const timing = info.mock.calls.filter((call) => call[0] === 'adapter' && call[1] === 'effective-timing');
    expect(timing.some((call) => (call[2] as { reason?: string }).reason === 'run')).toBe(true);
    const logged = JSON.stringify(timing);
    expect(logged).toContain('"printTimeout":"15m"');
    expect(logged).not.toContain('super-secret-user-prompt');
    expect(logged).not.toContain('--print-timeout');
  });
});

