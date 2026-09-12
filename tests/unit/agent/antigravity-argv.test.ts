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
});

