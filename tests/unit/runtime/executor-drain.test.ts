import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import * as spawn from '../../../src/platform/spawn';
import { runJsonlCli, wrapParsedTranslator } from '../../../src/agent/runner/jsonl-cli-runner';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { RunExecutor } from '../../../src/runtime/run-executor';
import type { AgentEvent } from '../../../src/agent/types';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';

afterEach(() => vi.restoreAllMocks());

const policy: RunPolicyAllow = {
  ok: true, prompt: 'hello', requestedCwd: '/tmp', cwdRealpath: '/tmp',
  accessMode: 'workspace', sandbox: 'workspace-write', permissionMode: 'acceptEdits',
  access: { ok: true, reason: 'allowed-user' }, attachments: [],
  policyFingerprint: 'fp', expiresAt: Number.MAX_SAFE_INTEGER,
};
async function collect(events: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function rawFixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  vi.spyOn(spawn, 'spawnProcess').mockImplementation(() => child as never);
  child.kill.mockImplementation((signal: NodeJS.Signals) => {
    const burst: AgentEvent[] = [
      ...Array.from({ length: 100 }, (_, i) => ({ type: 'text' as const, delta: String(i) })),
      { type: 'system', resumeHandle: 'final-before-exit' },
      { type: 'done', terminationReason: 'interrupted' },
    ];
    child.stdout.end(burst.map(e => JSON.stringify(e)).join('\n') + '\n');
    child.stderr.end();
    child.signalCode = signal;
    child.emit('exit', null, signal);
    return true;
  });
  let cleaned = false;
  const run = runJsonlCli({
    runId: 'stop-burst', binaryPath: '/fake', argv: [], cwd: '/tmp', env: {},
    spawnName: 'controlled-runner', stopGraceMs: 10, cleanup: () => { cleaned = true; },
    translator: wrapParsedTranslator({ translate: parsed => [parsed as AgentEvent] }, 'controlled-runner'),
  });
  return { run, cleaned: () => cleaned };
}
it.each(['raw runner', 'executor'] as const)('drains all events buffered before exit through %s', async mode => {
  const f = rawFixture();
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 2);
  const executor = new RunExecutor({
    agent: { id: 'fake-agent', displayName: 'fake', isAvailable: async () => true, run: () => f.run },
    activeRuns, pool, postDoneExitGraceMs: 100,
  });
  const execution = mode === 'executor' ? await executor.submit({ scopeId: 's', policy }) : undefined;
  const collecting = collect(execution ? execution.subscribe() : f.run.events);
  await (execution ? execution.stop() : f.run.stop());
  const events = await collecting;
  await execution?.finished;
  expect(f.cleaned()).toBe(true);
  expect(events).toContainEqual({ type: 'system', resumeHandle: 'final-before-exit' });
  expect(events.filter(e => e.type === 'text')).toHaveLength(100);
});

it.each([false, true])('keeps stop, finished and ownership pending until the source drains (source fails=%s)', async sourceFails => {
  const f = rawFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const failure = new Error('buffered source failed');
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const executor = new RunExecutor({
    agent: {
      id: 'fake-agent', displayName: 'fake', isAvailable: async () => true,
      run: () => ({ ...f.run, events: (async function* () {
        for await (const event of f.run.events) {
          if (event.type === 'text' && event.delta === '0') {
            entered();
            await gate;
            if (sourceFails) throw failure;
          }
          yield event;
        }
      })() }),
    },
    activeRuns, pool, postDoneExitGraceMs: 100,
  });
  const execution = await executor.submit({ scopeId: 's', policy });
  const events = collect(execution.subscribe()).catch(error => error);
  let stopDone = false;
  let finished = false;
  const stopping = execution.stop().then(() => { stopDone = true; }).catch(error => error);
  const finishing = execution.finished.then(() => { finished = true; }).catch(error => error);
  try {
    await paused;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.cleaned()).toBe(true);
    expect(stopDone).toBe(false);
    expect(finished).toBe(false);
    expect(activeRuns.get('s')?.run).toBe(execution.run);
    expect(pool.snapshot().active).toBe(1);
  } finally {
    release();
    await Promise.all([events, stopping, finishing]);
  }
  if (sourceFails) {
    expect(await events).toBe(failure);
    expect(await stopping).toBe(failure);
    expect(await finishing).toBe(failure);
  } else {
    expect(await events).toHaveLength(102);
    await stopping;
    await finishing;
    expect(stopDone).toBe(true);
    expect(finished).toBe(true);
  }
  expect(activeRuns.get('s')).toBeUndefined();
  expect(pool.snapshot().active).toBe(0);
});
