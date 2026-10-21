import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({ spawnProcess: vi.fn() }));
vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { GrokAdapter } from '../../../src/agent/grok/adapter';

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
  });
  spawnMock.spawnProcess.mockReturnValue(child);
  return child;
}

describe('Grok prompt file', () => {
  afterEach(() => {
    spawnMock.spawnProcess.mockReset();
  });

  it('passes --prompt-file instead of the prompt text and deletes the file after the run', async () => {
    const prompt = 'bridge prompt that must stay off argv';
    const child = fakeChild();
    const run = new GrokAdapter({ binary: 'grok' }).run({
      runId: 'r1',
      prompt,
      cwd: '/tmp',
    });
    const argv = spawnMock.spawnProcess.mock.calls.at(-1)?.[1] as string[];
    expect(argv).toContain('--prompt-file');
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain(prompt);
    const path = argv[argv.indexOf('--prompt-file') + 1] ?? '';
    expect(path).not.toBe('');
    expect(existsSync(path)).toBe(true);
    // Windows stat() reports 0o666 for every file; 0600 is a POSIX mode bit.
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    child.stdout.end();
    child.stderr.end();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    expect(await run.waitForExit(2000)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
