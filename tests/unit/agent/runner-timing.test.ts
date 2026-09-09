import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { runJsonlCli, wrapParsedTranslator } from '../../../src/agent/runner/jsonl-cli-runner.js';

const slot = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock('../../../src/platform/spawn', () => ({ spawnProcess: () => slot.child }));

function controlledChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
      child.signalCode = signal;
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', null, signal);
      return true;
    }),
  });
  slot.child = child;
  return child;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('resets idle when stdout arrives before the consumer asks for it', async () => {
  vi.useFakeTimers();
  const child = controlledChild();
  const run = runJsonlCli({
    runId: 'idle', binaryPath: '/fake', argv: [], cwd: '/tmp', env: {},
    spawnName: 'fake', timeouts: { idleMs: 70 }, stopGraceMs: 50,
    translator: wrapParsedTranslator({ translate: () => [] }, 'fake'),
  });
  try {
    for (let n = 0; n < 6; n++) {
      child.stdout.write(JSON.stringify({ n }) + '\n');
      await vi.advanceTimersByTimeAsync(40);
      expect(child.kill).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(31);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  } finally {
    await run.stop();
  }
});

it('times out when the child has produced no stdout since startup', async () => {
  vi.useFakeTimers();
  const child = controlledChild();
  const run = runJsonlCli({
    runId: 'silent-idle', binaryPath: '/fake', argv: [], cwd: '/tmp', env: {},
    spawnName: 'fake', timeouts: { idleMs: 70 }, stopGraceMs: 50,
    translator: wrapParsedTranslator({ translate: () => [] }, 'fake'),
  });
  try {
    await vi.advanceTimersByTimeAsync(69);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const events = [];
    for await (const event of run.events) events.push(event);
    expect(events).toEqual([
      { type: 'error', message: 'fake timeout', terminationReason: 'timeout' },
    ]);
    expect(await run.waitForExit(1_000)).toBe(true);
  } finally {
    await run.stop();
  }
});
