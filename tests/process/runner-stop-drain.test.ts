import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as spawn from '../../src/platform/spawn';
import { runJsonlCli, wrapParsedTranslator } from '../../src/agent/runner/jsonl-cli-runner';
import type { AgentEvent, AgentRun } from '../../src/agent/types';
import { ActiveRuns } from '../../src/bot/active-runs';
import { ProcessPool } from '../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../src/policy/run-policy';
import { RunExecutor } from '../../src/runtime/run-executor';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const policy: RunPolicyAllow = {
  ok: true, prompt: 'hello', requestedCwd: '/tmp', cwdRealpath: '/tmp',
  accessMode: 'workspace', sandbox: 'workspace-write', permissionMode: 'acceptEdits',
  access: { ok: true, reason: 'allowed-user' }, attachments: [],
  policyFingerprint: 'fp', expiresAt: Number.MAX_SAFE_INTEGER,
};

async function execute(raw: AgentRun) {
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const executor = new RunExecutor({
    agent: { id: 'fake', displayName: 'fake', isAvailable: async () => true, run: () => raw },
    activeRuns, pool, postDoneExitGraceMs: 100,
  });
  return { activeRuns, pool, execution: await executor.submit({ scopeId: 's', policy }) };
}

async function collect(events: AsyncIterable<AgentEvent>, received?: (event: AgentEvent) => void) {
  const result: AgentEvent[] = [];
  for await (const event of events) {
    result.push(event);
    received?.(event);
  }
  return result;
}

const translator = () => wrapParsedTranslator({
  translate: parsed => [parsed as AgentEvent],
  finish: reason => [{ type: 'done', terminationReason: reason === 'interrupted' ? 'interrupted' : 'normal' }],
}, 'inherited-stdout');

function controlled(options: { cleanup?: () => void | Promise<void> } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  vi.spyOn(spawn, 'spawnProcess').mockImplementation(() => child as never);
  child.kill.mockImplementation((signal: NodeJS.Signals) => {
    child.signalCode = signal;
    child.emit('exit', null, signal);
    return true;
  });
  const raw = runJsonlCli({
    runId: 'inherited-stdout', binaryPath: '/fake', argv: [], cwd: '/tmp', env: {},
    spawnName: 'inherited-stdout', stopGraceMs: 10, translator: translator(), ...options,
  });
  return { child, raw };
}

it.each(['return', 'stop', 'stopAll', 'already exited'] as const)('bounds executor %s after exit without stdout EOF and retains delayed unterminated output', async mode => {
  vi.useFakeTimers();
  let cleaned = false;
  const { child, raw } = controlled({ cleanup: () => { cleaned = true; } });
  const { execution, activeRuns, pool } = await execute(raw);
  const iterator = execution.subscribe()[Symbol.asyncIterator]();
  const first = iterator.next();
  child.stdout.write('{"type":"text","delta":"ready"}\n');
  await first;
  if (mode === 'already exited') {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  }
  let completed = false;
  const stopping = (mode === 'return' ? iterator.return!() : mode === 'stopAll' ? activeRuns.stopAll() : execution.stop())
    .then(() => { completed = true; });
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(await raw.waitForExit(1)).toBe(true);
    expect(cleaned).toBe(true);
    expect(completed).toBe(false);
    expect(pool.snapshot().active).toBe(1);
    child.stdout.write('{"type":"text","delta":"tail 🌟"}\n{"type":"system","resumeHandle":"last-no-newline"}');
    await vi.advanceTimersByTimeAsync(6000);
    expect(completed).toBe(true);
    expect(pool.snapshot().active).toBe(0);
    expect(activeRuns.get('s')).toBeUndefined();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await collect(execution.subscribe())).toEqual([
      { type: 'text', delta: 'ready' }, { type: 'text', delta: 'tail 🌟' },
      { type: 'system', resumeHandle: 'last-no-newline' },
      { type: 'done', terminationReason: mode === 'already exited' ? 'normal' : 'interrupted' },
    ]);
  } finally {
    child.stdout.end(); child.stderr.end();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.allSettled([stopping, execution.finished]);
  }
});

it('rejects a continuously writing inherited stdout at a fixed deadline and retains failed ownership', async () => {
  vi.useFakeTimers();
  const { child, raw } = controlled();
  const { execution, activeRuns, pool } = await execute(raw);
  let stopResult: unknown;
  let finishResult: unknown;
  const stopping = execution.stop().catch(error => { stopResult = error; });
  const finishing = execution.finished.catch(error => { finishResult = error; });
  const writing = setInterval(() => child.stdout.write('{"type":"text","delta":"descendant"}\n'), 10);
  try {
    await vi.advanceTimersByTimeAsync(6000);
    expect(stopResult).toMatchObject({ name: 'RunCleanupFailed' });
    expect(finishResult).toBe(stopResult);
    expect(pool.snapshot().active).toBe(1);
    expect(activeRuns.get('s')?.run).toBe(execution.run);
    await expect(activeRuns.stopAll()).rejects.toMatchObject({ name: 'AggregateError' });
    await expect(collect(execution.subscribe())).rejects.toBe(stopResult);
    expect(child.stdout.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(1); // Only the fixture's descendant writer remains.
  } finally {
    clearInterval(writing);
    child.stdout.end(); child.stderr.end();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.allSettled([stopping, finishing]);
  }
});

it('propagates cleanup failure while closing inherited pipes and retaining executor ownership', async () => {
  vi.useFakeTimers();
  const failure = new Error('cleanup refused');
  const { child, raw } = controlled({ cleanup: () => { throw failure; } });
  const { execution, activeRuns, pool } = await execute(raw);
  const stopping = execution.stop().catch(error => error);
  const finishing = execution.finished.catch(error => error);
  try {
    await vi.advanceTimersByTimeAsync(6000);
    expect(await stopping).toMatchObject({ name: 'RunCleanupFailed', cause: failure });
    expect(await finishing).toBe(await stopping);
    await expect(raw.waitForExit(1)).rejects.toMatchObject({ cause: failure });
    expect(child.stdout.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(pool.snapshot().active).toBe(1);
    expect(activeRuns.get('s')?.run).toBe(execution.run);
  } finally {
    child.stdout.end(); child.stderr.end();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.allSettled([stopping, finishing]);
  }
});

const portableStops = ['raw return', 'raw stop', 'executor return', 'executor stop', 'stopAll', 'post-exit OS tail'] as const;
type RealStopMode = typeof portableStops[number] | 'POSIX stop burst';

it.each(portableStops)(
  '%s settles with a real stdout-inheriting descendant alive and preserves the produced burst',
  runInheritedStdoutCase, 10000,
);

// Windows kill(SIGTERM) terminates abruptly; the six cases above establish
// their writes before stop. Keep signal-handler output covered on POSIX too.
it.skipIf(process.platform === 'win32')(
  'POSIX stop drains a large burst produced by the signal handler while a descendant holds stdout',
  () => runInheritedStdoutCase('POSIX stop burst'), 10000,
);

async function waitForWritten(path: string): Promise<void> {
  await expect.poll(async () => {
    try { return await readFile(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }, { timeout: 5000 }).toBe('written');
}

async function runInheritedStdoutCase(mode: RealStopMode): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'runner-stop-drain-'));
    const marker = join(dir, 'descendant.pid');
    const script = join(dir, 'agent.mjs');
    const burstRequest = join(dir, 'write-burst');
    const burstWritten = join(dir, 'burst-written');
    const tailRequest = join(dir, 'write-tail');
    const tailWritten = join(dir, 'tail-written');
    const text = '尾🌟'.repeat(2000);
    const burst: AgentEvent[] = Array.from({ length: 100 }, (_, i) => ({ type: 'text', delta: `${i}:${text}` }));
    burst.push({ type: 'system', resumeHandle: 'real-final-no-newline' });
    const descendant = "setTimeout(()=>process.exit(0),15000); process.send('ready');";
    const signalWriter = mode === 'POSIX stop burst'
      ? `process.on('SIGTERM', () => process.stdout.write(${JSON.stringify(burst.map(event => JSON.stringify(event)).join('\n'))}, () => process.exit(0)));`
      : '';
    await writeFile(script, `import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
if (descendant.pid) writeFileSync(${JSON.stringify(marker)}, String(descendant.pid));
descendant.once('message', () => {
  console.log('{"type":"text","delta":"ready"}');
  descendant.disconnect(); descendant.unref();
});
${signalWriter}
let phase = 'burst';
setInterval(() => {
  if (phase === 'burst' && existsSync(${JSON.stringify(burstRequest)})) {
    phase = 'writing-burst';
    process.stdout.write(${JSON.stringify(burst.slice(0, -1).map(event => JSON.stringify(event)).join('\n') + '\n')}, error => {
      if (error) throw error;
      writeFileSync(${JSON.stringify(burstWritten)}, 'written');
      phase = 'tail';
    });
  } else if (phase === 'tail' && existsSync(${JSON.stringify(tailRequest)})) {
    phase = 'writing-tail';
    process.stdout.write(${JSON.stringify(JSON.stringify(burst[burst.length - 1]))}, error => {
      if (error) throw error;
      writeFileSync(${JSON.stringify(tailWritten)}, 'written');
      phase = 'waiting-for-stop';
    });
  }
}, 5);
`);
    let cleanups = 0;
    let pausedStdout: Readable | undefined;
    if (mode === 'post-exit OS tail') {
      const realSpawn = spawn.spawnProcess;
      vi.spyOn(spawn, 'spawnProcess').mockImplementation((binary, argv, options) => {
        const child = realSpawn(binary, argv, options);
        pausedStdout = child.stdout as Readable;
        return child;
      });
    }
    const raw = runJsonlCli({
      runId: 'real-inherited-stdout', binaryPath: process.execPath, argv: [script], cwd: dir, env: { ...process.env },
      spawnName: 'inherited-stdout', stopGraceMs: 1000, translator: translator(), cleanup: () => { cleanups++; },
    });
    const h = mode.startsWith('raw') ? undefined : await execute(raw);
    const iterator = (h?.execution.subscribe() ?? raw.events)[Symbol.asyncIterator]();
    let descendantPid: number | undefined;
    let stopping: Promise<unknown> | undefined;
    let remaining: Promise<AgentEvent[]> | undefined;
    let collected = false;
    let textEvents = 0;
    try {
      expect(await iterator.next()).toMatchObject({ value: { type: 'text', delta: 'ready' } });
      descendantPid = Number(await readFile(marker, 'utf8'));
      if (!mode.endsWith('return')) remaining = collect({ [Symbol.asyncIterator]: () => iterator }, event => {
        if (event.type === 'text') textEvents++;
      })
        .then(events => { collected = true; return events; });
      if (mode !== 'POSIX stop burst') {
        // A successful write callback establishes the data before any platform's
        // stop signal. No cross-platform case depends on a JS signal handler.
        await writeFile(burstRequest, 'go');
        await waitForWritten(burstWritten);
        if (pausedStdout) {
          // Drain the large burst first: only the small unterminated handle
          // must fit in the inherited native pipe while delivery is paused.
          await expect.poll(() => textEvents, { timeout: 5000 }).toBe(100);
          pausedStdout.pause();
        }
        await writeFile(tailRequest, 'go');
        await waitForWritten(tailWritten);
      }
      let completed = false;
      stopping = (mode.endsWith('return') ? iterator.return!()
        : mode === 'stopAll' ? h!.activeRuns.stopAll() : h ? h.execution.stop() : raw.stop())
        .then(() => { completed = true; });
      expect(await raw.waitForExit(5000)).toBe(true);
      if (pausedStdout) {
        expect(completed).toBe(false);
        expect(h!.pool.snapshot().active).toBe(1);
        pausedStdout.resume();
      }
      await expect.poll(() => completed && (!remaining || collected), { timeout: 250 }).toBe(true);
      expect(cleanups).toBe(1);
      // Windows TerminateProcess / job objects reap inherited descendants with
      // the CLI. POSIX is where we pin that stop leaves them alive.
      if (process.platform !== 'win32') {
        expect(() => process.kill(descendantPid!, 0)).not.toThrow();
      }
      expect(completed).toBe(true);
      if (remaining) expect(collected).toBe(true);
      if (h) {
        await h.execution.finished;
        expect(h.pool.snapshot().active).toBe(0);
        expect(h.activeRuns.get('s')).toBeUndefined();
        expect(await collect(h.execution.subscribe())).toEqual([
          { type: 'text', delta: 'ready' }, ...burst, { type: 'done', terminationReason: 'interrupted' },
        ]);
      } else if (remaining) {
        expect(await remaining).toEqual([...burst, { type: 'done', terminationReason: 'interrupted' }]);
      }
      await raw.stop();
      expect(cleanups).toBe(1);
    } finally {
      pausedStdout?.resume();
      descendantPid ??= Number(await readFile(marker, 'utf8').catch(() => '0')) || undefined;
      if (descendantPid) {
        try { process.kill(descendantPid, 'SIGTERM'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await raw.stop();
      await Promise.allSettled([stopping, remaining, h?.execution.finished]);
      await rm(dir, { recursive: true, force: true });
    }
}
