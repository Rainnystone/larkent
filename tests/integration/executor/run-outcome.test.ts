import { describe, expect, it } from 'vitest';
import { descriptorFor } from '../../../src/agent/registry';
import type { AgentAdapter, AgentEvent } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor, type RunExecutorDeps } from '../../../src/runtime/run-executor';

describe('executor-owned run outcome', () => {
  it('publishes one stable outcome only after child exit and cleanup', async () => {
    const h = harness();
    const execution = await h.executor.submit({ scopeId: 'synthetic', policy });
    const first = execution.subscribe()[Symbol.asyncIterator]();
    expect(await first.next()).toMatchObject({ value: { type: 'done' } });
    expect(execution.handle.outcome).toBeUndefined();
    h.settle();
    await execution.finished;
    const outcome = execution.handle.outcome;
    expect(outcome).toEqual({ kind: 'completed', retriable: false, needsHuman: false });
    await first.return?.();
    for await (const _event of execution.subscribe()) { /* replay the settled stream */ }
    await execution.stop();
    expect(execution.handle.outcome).toBe(outcome);
  });

  it('classifies an outage from the live link getter after terminal and before settlement', async () => {
    let link = { outageEpoch: () => 4, isDown: () => false };
    const h = harness({ getLink: () => link }, {
      terminal: { type: 'error', message: 'Synthetic failure', terminationReason: 'failed' },
    });
    const execution = await h.executor.submit({ scopeId: 'synthetic', policy });
    const events = execution.subscribe()[Symbol.asyncIterator]();
    await events.next();
    link = { outageEpoch: () => 5, isDown: () => false };
    h.settle();
    await execution.finished;
    expect(execution.handle.outcome).toEqual({
      kind: 'failed', cause: 'transient-upstream', retriable: true, needsHuman: false,
    });
    await events.return?.();
  });

  it('remembers a run that started while the link was down even after recovery', async () => {
    let down = true;
    const h = harness({ getLink: () => ({ outageEpoch: () => 4, isDown: () => down }) }, {
      terminal: { type: 'error', message: 'Synthetic failure', terminationReason: 'failed' },
    });
    const execution = await h.executor.submit({ scopeId: 'synthetic', policy });
    down = false;
    h.settle();
    await execution.finished;
    expect(execution.handle.outcome).toEqual({
      kind: 'failed', cause: 'transient-upstream', retriable: true, needsHuman: false,
    });
  });

  it('uses the settled stderr snapshot before a conflicting terminal signature', async () => {
    const evidence = {
      terminal: { type: 'error', message: 'RetriableError: Connection stalled repeatedly', terminationReason: 'failed' } as const,
      stderr: '',
    };
    const h = harness({ stderrSignatures: () => descriptorFor('cursor').stderrSignatures }, evidence);
    const execution = await h.executor.submit({ scopeId: 'synthetic', policy });
    const events = execution.subscribe()[Symbol.asyncIterator]();
    await events.next();
    evidence.stderr = 'Your stored authentication is invalid.';
    h.settle();
    await execution.finished;
    expect(execution.handle.outcome).toEqual({
      kind: 'failed', cause: 'auth-required', retriable: false, needsHuman: true,
    });
    await events.return?.();
  });

  it.each([
    { name: 'exit without terminal', terminal: null, exit: 17, signal: undefined,
      expected: { kind: 'failed', cause: 'unclassified', retriable: true, needsHuman: false } },
    { name: 'settled kill signal', terminal: null, exit: null, signal: 'SIGKILL',
      expected: { kind: 'failed', cause: 'killed-externally', retriable: true, needsHuman: false } },
    { name: 'runner timeout', terminal: { type: 'done', terminationReason: 'timeout' }, exit: 0, signal: undefined,
      expected: { kind: 'interrupted', reason: { type: 'runner-timeout' }, retriable: true, needsHuman: false } },
  ] as const)('exposes $name without a stream consumer', async ({ expected, ...evidence }) => {
    const h = harness({}, evidence);
    const execution = await h.executor.submit({ scopeId: 'synthetic', policy });
    h.settle();
    await execution.finished;
    expect(execution.handle.outcome).toEqual(expected);
  });

  it.each([
    { terminal: 'interrupted', expected: { kind: 'interrupted', reason: { type: 'user-stop' }, retriable: false, needsHuman: false } },
    { terminal: 'normal', expected: { kind: 'completed', retriable: false, needsHuman: false } },
  ] as const)('keeps first stop intent and respects a $terminal terminal', async ({ terminal, expected }) => {
    const h = harness({}, { terminal: { type: 'done', terminationReason: terminal } });
    const execution = await h.executor.submit({ scopeId: 'synthetic', policy });
    h.activeRuns.interrupt('synthetic', { type: 'user-stop' });
    await execution.finished;
    expect(execution.handle.stopRequest).toEqual({ type: 'user-stop' });
    expect(execution.handle.outcome).toEqual(expected);
  });
});

function harness(overrides: Partial<RunExecutorDeps> = {}, evidence: {
  terminal?: AgentEvent | null; stderr?: string; exit?: number | null; signal?: string | null;
} = {}) {
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const agent: AgentAdapter = {
    id: 'synthetic', displayName: 'Synthetic', isAvailable: async () => true,
    run: options => ({
      runId: options.runId,
      events: (async function* (): AsyncGenerator<AgentEvent> {
        if (evidence.terminal !== null) yield evidence.terminal ?? { type: 'done', terminationReason: 'normal' };
      })(),
      get stderrSnapshot() { return evidence.stderr; },
      get exit() { return evidence.exit; },
      get signal() { return evidence.signal; },
      waitForExit: async () => { await cleanup; return true; },
      stop: async () => { release(); },
    }),
  };
  const activeRuns = new ActiveRuns();
  return {
    activeRuns,
    settle: () => release(),
    executor: new RunExecutor({ agent, activeRuns, pool: new ProcessPool(() => 1), ...overrides }),
  };
}

const policy: RunPolicyAllow = {
  ok: true, prompt: 'Synthetic run', requestedCwd: '/tmp', cwdRealpath: '/tmp',
  accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
  access: { ok: true, reason: 'allowed-user' }, attachments: [],
  policyFingerprint: 'synthetic', expiresAt: Number.MAX_SAFE_INTEGER,
};
