import { describe, expect, it, vi, afterEach } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { AgentAdapter, AgentRun, AgentEvent } from '../../../src/agent/types';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('RunExecutor settlement', () => {
  it.each(['return', 'terminal break'] as const)('reports completed cleanup failure on subscriber %s', async mode => {
    const failure = new Error('adapter cleanup failed');
    const cleanup = deferred<void>();
    const stop = vi.fn(async () => { throw failure; });
    const waitForExit = vi.fn(async () => { await cleanup.promise; throw failure; });
    const h = harness(adapter({
      events: (async function* () { yield { type: 'done', terminationReason: 'normal' } as const; })(),
      stop, waitForExit,
    }));
    const execution = await h.executor.submit({ scopeId: 's', policy: policy() });
    const finishFailure = execution.finished.catch(error => error);
    const observeFailure = async () => {
      cleanup.resolve();
      expect(await finishFailure).toBe(failure);
    };
    if (mode === 'return') {
      const iterator = execution.subscribe()[Symbol.asyncIterator]();
      expect(await iterator.next()).toMatchObject({ value: { type: 'done' } });
      await observeFailure();
      await expect(iterator.return!()).rejects.toBe(failure);
    } else {
      const consume = async () => {
        for await (const event of execution.subscribe()) {
          expect(event.type).toBe('done');
          await observeFailure();
          break;
        }
      };
      await expect(consume()).rejects.toBe(failure);
    }
    expect(h.activeRuns.get('s')?.run).toBe(execution.run);
    expect(h.pool.snapshot().active).toBe(1);
    expect(stop).not.toHaveBeenCalled();
    expect(waitForExit).toHaveBeenCalledTimes(1);
  });

  it('does not release ownership while a force stop joins an in-flight settlement check', async () => {
    vi.useFakeTimers();
    const firstWait = deferred<boolean>();
    const lastWait = deferred<boolean>();
    const stopGate = deferred<void>();
    let waits = 0;
    let stopped = false;
    const h = harness(adapter({
      events: (async function* () { yield { type: 'done', terminationReason: 'normal' } as const; })(),
      stop: async () => { stopped = true; await stopGate.promise; },
      waitForExit: async () => ++waits === 1 ? firstWait.promise : lastWait.promise,
    }));
    const execution = await h.executor.submit({ scopeId: 's', policy: policy() });
    await execution.subscribe()[Symbol.asyncIterator]().next();
    firstWait.resolve(true);
    // The first check already confirmed exit + cleanup. If an unnecessary
    // second wait exists, a concurrent stop must still join the transaction.
    await vi.advanceTimersByTimeAsync(0);
    const stop = execution.stop();
    let finished = false;
    void execution.finished.then(() => { finished = true; });
    lastWait.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    if (stopped) {
      expect(finished).toBe(false);
      expect(h.pool.snapshot().active).toBe(1);
    } else {
      expect(finished).toBe(true);
      expect(h.pool.snapshot().active).toBe(0);
    }
    stopGate.resolve();
    await stop;
    expect(h.pool.snapshot().active).toBe(0);
  });
  it.each(['stop', 'stopAll'] as const)('wakes pending next and finished when external %s fails with an open source', async method => {
    const failure = new Error('exit never confirmed');
    const h = harness(adapter({
      events: (async function* () { await new Promise(() => {}); yield { type: 'done', terminationReason: 'normal' } as const; })(),
      stop: async () => { throw failure; },
      waitForExit: async () => false,
    }));
    const execution = await h.executor.submit({ scopeId: 's', policy: policy() });
    const next = expect(execution.subscribe()[Symbol.asyncIterator]().next()).rejects.toBe(failure);
    const finished = expect(execution.finished).rejects.toBe(failure);
    if (method === 'stop') await expect(execution.stop()).rejects.toBe(failure);
    else await expect(h.activeRuns.stopAll()).rejects.toMatchObject({ errors: [failure] });
    await Promise.all([next, finished]);
    expect(h.activeRuns.get('s')?.run).toBe(execution.run);
    expect(h.pool.snapshot().active).toBe(1);
  });
  it('pumps and finishes a run even when nobody subscribes', async () => {
    const h = harness(new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] }));
    const execution = await h.executor.submit({ scopeId: 's', policy: policy() });
    expect(execution.finished).toBeInstanceOf(Promise);
    await execution.finished;
    expect(h.activeRuns.get('s')).toBeUndefined();
    expect(h.pool.snapshot().active).toBe(0);
  });

  it('interrupt immediately stops a terminal run already waiting for exit', async () => {
    vi.useFakeTimers();
    const exited = deferred<void>();
    let stopped = false;
    const agent = adapter({
      events: (async function* () { yield { type: 'done', terminationReason: 'normal' } as const; })(),
      stop: async () => { stopped = true; exited.resolve(); },
      waitForExit: async () => { await exited.promise; return true; },
    });
    const h = harness(agent);
    const execution = await h.executor.submit({ scopeId: 's', policy: policy() });
    const iterator = execution.subscribe()[Symbol.asyncIterator]();
    await iterator.next();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.activeRuns.interrupt('s')).toBe(true);
    expect(stopped).toBe(true);
    await execution.finished;
    expect(h.pool.snapshot().active).toBe(0);
  });

  it('stops when the last subscriber breaks before terminal', async () => {
    const source = openRun();
    const h = harness(adapter(source.run));
    const execution = await h.executor.submit({ scopeId: 's', policy: policy() });
    for await (const event of execution.subscribe()) {
      expect(event).toEqual({ type: 'text', delta: 'hello' });
      break;
    }
    expect(source.stopped()).toBe(true);
    await execution.finished;
    expect(h.pool.snapshot().active).toBe(0);
  });

  it('keeps running when one of two actual subscribers returns', async () => {
    const source = openRun();
    const h = harness(adapter(source.run));
    const execution = await h.executor.submit({ scopeId: 's', policy: policy() });
    const first = execution.subscribe()[Symbol.asyncIterator]();
    const second = execution.subscribe()[Symbol.asyncIterator]();
    await Promise.all([first.next(), second.next()]);
    expect(first.return).toBeTypeOf('function');
    await first.return?.();
    expect(source.stopped()).toBe(false);
    source.end();
    expect(await second.next()).toMatchObject({ value: { type: 'done' } });
    await execution.finished;
    expect(h.pool.snapshot().active).toBe(0);
  });

  it('wakes all subscribers and rejects finished when cleanup fails without releasing another run', async () => {
    const cleanupError = new Error('cleanup failed');
    const gate = deferred<void>();
    const h = harness(adapter({
      events: (async function* () { yield { type: 'done', terminationReason: 'normal' } as const; })(),
      stop: async () => { throw cleanupError; },
      waitForExit: async () => { await gate.promise; throw cleanupError; },
    }));
    const other = new FakeAgentAdapter().run({ runId: 'other', prompt: '' });
    h.activeRuns.register('other', other);
    const releaseOther = h.pool.tryAcquire()!;
    const execution = await h.executor.submit({ scopeId: 's', policy: policy() });
    expect(execution.finished).toBeInstanceOf(Promise);
    const finished = expect(execution.finished).rejects.toBe(cleanupError);
    const first = execution.subscribe()[Symbol.asyncIterator]();
    const second = execution.subscribe()[Symbol.asyncIterator]();
    await Promise.all([first.next(), second.next()]);
    const waiting = [expect(first.next()).rejects.toBe(cleanupError), expect(second.next()).rejects.toBe(cleanupError)];
    gate.resolve();
    await Promise.all([finished, ...waiting]);
    expect(h.activeRuns.get('s')?.run).toBe(execution.run);
    expect(h.activeRuns.get('other')?.run).toBe(other);
    expect(h.pool.snapshot().active).toBe(2);
    await expect(execution.stop()).rejects.toBe(cleanupError);
    releaseOther();
  });

  it('rejects all waiters on a source exception after stopping its run', async () => {
    const failure = new Error('source failed');
    let stopped = false;
    const h = harness(adapter({
      events: (async function* () { throw failure; yield { type: 'text', delta: '' } as const; })(),
      stop: async () => { stopped = true; },
      waitForExit: async () => stopped,
    }));
    const execution = await h.executor.submit({ scopeId: 's', policy: policy() });
    expect(execution.finished).toBeInstanceOf(Promise);
    const finished = expect(execution.finished).rejects.toBe(failure);
    await expect(collect(execution.subscribe())).rejects.toBe(failure);
    await finished;
    expect(stopped).toBe(true);
    expect(h.pool.snapshot().active).toBe(0);
  });

  it('releases a failed prepare reservation and slot so that the scope can retry', async () => {
    const agent = new FakeAgentAdapter();
    const prepareRun = vi.fn().mockRejectedValueOnce(new Error('prepare failed')).mockResolvedValue(undefined);
    const h = harness(Object.assign(agent, { prepareRun }));
    await expect(h.executor.submit({ scopeId: 's', policy: policy() })).rejects.toMatchObject({ code: 'agent-prepare-failed' });
    expect(h.pool.snapshot().active).toBe(0);
    const retried = await h.executor.submit({ scopeId: 's', policy: policy() });
    await retried.finished;
  });

  it('waits for an already spawned child before releasing a failed registration', async () => {
    const source = openRun();
    const gate = deferred<void>();
    const h = harness(adapter({ ...source.run, stop: async () => { await gate.promise; await source.run.stop(); } }));
    vi.spyOn(h.activeRuns, 'register').mockImplementationOnce(() => { throw new Error('register failed'); });
    const submitted = h.executor.submit({ scopeId: 's', policy: policy() });
    const rejection = expect(submitted).rejects.toMatchObject({ code: 'run-already-active' });
    await vi.waitFor(() => expect(h.pool.snapshot().active).toBe(1));
    // A second microtask drain reaches the failed-register cleanup.
    await Promise.resolve();
    expect(h.pool.snapshot().active).toBe(1);
    expect(h.activeRuns.reserve('s')).toBeUndefined();
    gate.resolve();
    await rejection;
    expect(h.pool.snapshot().active).toBe(0);
    expect(h.activeRuns.reserve('s')).toBeTypeOf('function');
  });
  it('holds the scope and pool slot until terminal cleanup finishes', async () => {
    let releaseCleanup!: () => void;
    let cleaned = false;
    const barrier = new Promise<void>(resolve => {
      releaseCleanup = () => { cleaned = true; resolve(); };
    });
    const agent: AgentAdapter = {
      id: 'fake-agent', displayName: 'fake', isAvailable: async () => true,
      run: opts => ({
        runId: opts.runId,
        events: (async function* () { yield { type: 'done', terminationReason: 'normal' } as const; })(),
        stop: () => barrier,
        waitForExit: async () => cleaned,
      }),
    };
    const activeRuns = new ActiveRuns();
    const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({ agent, activeRuns, pool, now: () => 1000, postDoneExitGraceMs: 1 });
    const execution = await executor.submit({ scopeId: 's', policy: policy() });
    const iterator = execution.subscribe()[Symbol.asyncIterator]();
    await iterator.next();
    try {
      expect(activeRuns.get('s')).toBeDefined();
      expect(pool.snapshot().active).toBe(1);
    } finally {
      releaseCleanup();
    }
    await execution.finished;
    expect(activeRuns.get('s')).toBeUndefined();
    expect(pool.snapshot().active).toBe(0);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function adapter(run: Omit<AgentRun, 'runId'>): AgentAdapter {
  return { id: 'fake-agent', displayName: 'fake', isAvailable: async () => true,
    run: opts => ({ ...run, runId: opts.runId }) };
}

function harness(agent: AgentAdapter) {
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 2);
  const executor = new RunExecutor({ agent, activeRuns, pool, now: () => 1000, postDoneExitGraceMs: 1 });
  return { activeRuns, pool, executor };
}

function openRun() {
  const end = deferred<void>();
  let stopped = false;
  let exited = false;
  const run: Omit<AgentRun, 'runId'> = {
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'text', delta: 'hello' };
      await end.promise;
      yield { type: 'done', terminationReason: stopped ? 'interrupted' : 'normal' };
    })(),
    stop: async () => { stopped = true; exited = true; end.resolve(); },
    waitForExit: async () => exited,
  };
  return { run, stopped: () => stopped, end: () => { exited = true; end.resolve(); } };
}

describe('RunExecutor policy runtime options', () => {
  it('passes policy sandbox and permission mode into each agent run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-policy',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-policy',
      policy: policy({
        sandbox: 'workspace-write',
        permissionMode: 'acceptEdits',
      }),
    });

    expect(agent.runOptions[0]).toMatchObject({
      runId: 'run-policy',
      sandbox: 'workspace-write',
      permissionMode: 'acceptEdits',
    });

    await collect(execution.subscribe());
  });

  it('passes descriptor mapEffectiveAccess as the per-run agentOptions bag', async () => {
    const agent = new FakeAgentAdapter({
      id: 'claude',
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-mapped',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-mapped',
      policy: policy({ accessMode: 'workspace' }),
    });

    expect(agent.runOptions[0]?.agentOptions).toMatchObject({ permissionMode: 'acceptEdits' });

    await collect(execution.subscribe());
  });
});

function policy(overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: '/tmp/repo',
    cwdRealpath: '/tmp/repo',
    accessMode: 'workspace',
    sandbox: 'workspace-write',
    permissionMode: 'acceptEdits',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}
