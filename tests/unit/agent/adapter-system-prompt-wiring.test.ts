import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import {
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import { CursorAdapter } from '../../../src/agent/cursor/adapter';
import { GrokAdapter } from '../../../src/agent/grok/adapter';
import { KimiAdapter } from '../../../src/agent/kimi/adapter';

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

describe('ClaudeAdapter system prompt wiring', () => {
  it('appends the identity-aware bridge system prompt via a temp file after setBotIdentity', async () => {
    const child = fakeChild();
    child.exitCode = null;
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    let promptPath: string | undefined;
    try {
      promptPath = systemPromptFilePath();
      // Keep the child alive while checking its input; exit owns prompt cleanup.
      // The prompt goes via stdin, never argv (cmd.exe would mangle it on Windows).
      expect(await readAll(child.stdin)).toBe('hi');
      expect(readFileSync(promptPath, 'utf8')).toBe(
        buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
      );
    } finally {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      child.stdout.end();
      child.stderr.end();
      expect(await run.waitForExit(1000)).toBe(true);
      if (promptPath) expect(existsSync(promptPath)).toBe(false);
    }
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    child.exitCode = null;
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();

    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    let promptPath: string | undefined;
    try {
      promptPath = systemPromptFilePath();
      expect(await readAll(child.stdin)).toBe('hi');
      expect(readFileSync(promptPath, 'utf8')).toBe(buildBridgeSystemPrompt(undefined));
    } finally {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      child.stdout.end();
      child.stderr.end();
      expect(await run.waitForExit(1000)).toBe(true);
      if (promptPath) expect(existsSync(promptPath)).toBe(false);
    }
  });

  function systemPromptFilePath(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--append-system-prompt-file');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args).not.toContain('--append-system-prompt');
    return args[flagIndex + 1] as string;
  }
});

describe('CodexAdapter system prompt wiring', () => {  function codexAdapter(): CodexAdapter {
    return new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: '/tmp/codex-profile',
    });
  }

  it('prefixes stdin with the identity-aware bridge system prompt after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(
      prefixBridgeSystemPrompt('hi', { openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(prefixBridgeSystemPrompt('hi', undefined));
  });
});

describe('KimiAdapter system prompt wiring', () => {
  function kimiAdapter(): KimiAdapter {
    return new KimiAdapter({ binary: '/usr/local/bin/kimi' });
  }

  function argvPrompt(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe('-p');
    return args[1] as string;
  }

  it('prefixes the argv prompt with the identity-aware bridge system prompt after setBotIdentity', () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = kimiAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(argvPrompt()).toBe(
      prefixBridgeSystemPrompt('hi', { openId: 'ou_bot_self', name: 'Bridge' }),
    );
    // stdin is closed without content: kimi reads the prompt from argv only.
    expect(child.stdin.readableEnded || child.stdin.writableEnded).toBe(true);
  });

  it('falls back to the base system prompt when no identity was set', () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = kimiAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(argvPrompt()).toBe(prefixBridgeSystemPrompt('hi', undefined));
  });
});

describe('GrokAdapter system prompt wiring', () => {
  function grokAdapter(): GrokAdapter {
    return new GrokAdapter({ binary: '/usr/local/bin/grok' });
  }

  function argv(): string[] {
    return spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
  }

  it('sends the identity-aware bridge prompt via --rules and keeps the user prompt clean', () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = grokAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const args = argv();
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('hi');
    expect(args[args.indexOf('--rules') + 1]).toBe(
      buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    );
    expect(child.stdin.readableEnded || child.stdin.writableEnded).toBe(true);
  });

  it('falls back to the base system prompt when no identity was set', () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = grokAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const args = argv();
    expect(args[1]).toBe('hi');
    expect(args[args.indexOf('--rules') + 1]).toBe(buildBridgeSystemPrompt(undefined));
  });
});

describe('CursorAdapter system prompt wiring', () => {
  function cursorAdapter(): CursorAdapter {
    return new CursorAdapter({ binary: '/usr/local/bin/cursor-agent' });
  }

  function argvPrompt(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe('-p');
    return args.at(-1) as string;
  }

  it('prefixes the positional prompt with the identity-aware bridge system prompt after setBotIdentity', () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = cursorAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(argvPrompt()).toBe(
      prefixBridgeSystemPrompt('hi', { openId: 'ou_bot_self', name: 'Bridge' }),
    );
    expect(child.stdin.readableEnded || child.stdin.writableEnded).toBe(true);
  });

  it('falls back to the base system prompt when no identity was set', () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = cursorAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(argvPrompt()).toBe(prefixBridgeSystemPrompt('hi', undefined));
  });
});

async function readAll(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
