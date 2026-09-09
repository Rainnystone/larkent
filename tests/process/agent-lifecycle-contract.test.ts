import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDefaultProfileConfig } from '../../src/config/profile-schema.js';
import { createRuntimeAgent } from '../../src/runtime/agent-runtime.js';
import * as runner from '../../src/agent/runner/jsonl-cli-runner.js';
import { ActiveRuns } from '../../src/bot/active-runs.js';
import { ProcessPool } from '../../src/bot/process-pool.js';
import { log } from '../../src/core/logger.js';
import { RunExecutor } from '../../src/runtime/run-executor.js';
import type { RunPolicyAllow } from '../../src/policy/run-policy.js';
import type { AgentEvent } from '../../src/agent/types.js';
import { PIN_AGENT_KINDS, jsonlScript, type PinAgentKind } from '../helpers/scripted-jsonl-cli.js';
import { installControlledKindCli } from '../helpers/controlled-kind-cli.js';
import { createTmpProfile, type TmpProfile } from '../helpers/tmp-profile.js';

const cleanups: TmpProfile[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map(tmp => tmp.cleanup()));
});

async function fixture(kind: PinAgentKind) {
  const tmp = await createTmpProfile('lifecycle-');
  cleanups.push(tmp);
  const fake = await installControlledKindCli(tmp.root, kind, 'A');
  const profile = createDefaultProfileConfig({
    agentKind: kind,
    binaryPath: fake.path,
    accounts: { app: { id: 'test-app', secret: 'test-secret', tenant: 'feishu' } },
    ...(kind === 'codex' ? {
      codex: { binaryPath: fake.path, inheritCodexHome: false, codexHome: join(tmp.root, 'codex') },
    } : {}),
  });
  if (kind === 'codex') await mkdir(join(tmp.root, 'codex'));
  const agent = createRuntimeAgent(profile, { profileDir: tmp.profile });
  const opts = { runId: 'run-A', prompt: 'hello', cwd: tmp.workspace, stopGraceMs: 50 };
  return { tmp, fake, profile, agent, opts };
}
async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function answer(events: AgentEvent[]): string {
  return events.map(e => e.type === 'text' ? e.delta : e.type === 'final_text' ? e.content : '').join('');
}

describe('shared real adapter lifecycle', () => {
  it.each(PIN_AGENT_KINDS)('%s completes with its own answer and handle', async kind => {
    const { fake, agent, opts } = await fixture(kind);
    await agent.prepareRun?.(opts);
    const run = agent.run(opts);
    try {
      const pending = collect(run.events);
      await fake.waitReady();
      await fake.release();
      const events = await pending;
      expect(events.some(e => e.type === 'done')).toBe(true);
      expect(events.filter(e => e.type === 'error')).toEqual([]);
      expect(answer(events)).toContain('ANSWER_A');
      expect(events.some(e => 'resumeHandle' in e && e.resumeHandle === fake.resumeHandle)).toBe(true);
      if (kind === 'grok') {
        // Grok introduces the normalized system event at end, not at stream start.
        expect(events).toContainEqual({ type: 'system', resumeHandle: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
        expect(events).toContainEqual({ type: 'done', resumeHandle: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', terminationReason: 'normal' });
      }
      expect(await run.waitForExit(1000)).toBe(true);
    } finally { await run.stop(); }
  });

  it.each(PIN_AGENT_KINDS)('%s reports stderr and a nonzero exit', async kind => {
    const { fake, agent, opts } = await fixture(kind);
    const warnings = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await fake.setScript(jsonlScript(kind, 'error'));
    await agent.prepareRun?.(opts);
    const run = agent.run(opts);
    try {
      const pending = collect(run.events);
      await fake.waitReady();
      await fake.release();
      const events = await pending;
      expect(events.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ message: expect.stringContaining('PINNED_ERROR'), terminationReason: 'failed' }),
      ]);
      expect(events.some(e => e.type === 'done')).toBe(false);
      expect(warnings).toHaveBeenCalledWith('agent', 'stderr', { line: 'PINNED_ERROR' });
      expect(await run.waitForExit(1000)).toBe(true);
    } finally { await run.stop(); }
  });

  it.each(PIN_AGENT_KINDS)('%s reports a missing executable at prepare or spawn', async kind => {
    const { tmp, profile, opts } = await fixture(kind);
    profile.agent.binaryPath = join(tmp.root, 'missing-cli');
    const agent = createRuntimeAgent(profile, { profileDir: tmp.profile });
    if (agent.prepareRun) {
      await expect(agent.prepareRun(opts)).rejects.toMatchObject({ code: 'agent-binary-not-found' });
    } else {
      const run = agent.run(opts);
      try {
        const events = await collect(run.events);
        expect(events).toEqual([expect.objectContaining({ type: 'error', terminationReason: 'failed' })]);
        expect(await run.waitForExit(1000)).toBe(true);
      } finally { await run.stop(); }
    }
  });

  it.each(PIN_AGENT_KINDS)('%s stops a ready child twice and confirms reclamation', async kind => {
    const { fake, agent, opts } = await fixture(kind);
    await agent.prepareRun?.(opts);
    const run = agent.run(opts);
    try {
      const pending = collect(run.events);
      await fake.waitReady();
      const pid = await readyPid(fake.readyPath);
      expect(alive(pid)).toBe(true);
      expect(await run.waitForExit(20)).toBe(false);
      await Promise.all([run.stop(), run.stop()]);
      await run.stop();
      await pending;
      expect(await run.waitForExit(1000)).toBe(true);
      expect(alive(pid)).toBe(false);
    } finally { await run.stop(); }
  });

  it.each(PIN_AGENT_KINDS)('%s creates fresh translator state on the same adapter second run', async kind => {
    const { fake, agent, opts } = await fixture(kind);
    for (const turn of [1, 2]) {
      const script = jsonlScript(kind, 'success');
      if (turn === 2) script.lines = JSON.parse(JSON.stringify(script.lines).replaceAll('PINNED_ANSWER', 'SECOND_ANSWER'));
      await fake.setScript(script);
      await agent.prepareRun?.(opts);
      const run = agent.run({ ...opts, runId: `run-${turn}`, prompt: `prompt-${turn}` });
      try {
        const pending = collect(run.events);
        await fake.waitReady();
        await fake.release();
        const events = await pending;
        expect(events.filter(e => e.type === 'done')).toHaveLength(1);
        expect(events.filter(e => e.type === 'error')).toEqual([]);
        expect(answer(events)).toContain(turn === 1 ? 'ANSWER_A' : 'SECOND_ANSWER');
        if (turn === 2) expect(answer(events)).not.toContain('ANSWER_A');
        expect(events.some(e => 'resumeHandle' in e && e.resumeHandle === fake.resumeHandle)).toBe(true);
        expect(await run.waitForExit(1000)).toBe(true);
      } finally { await run.stop(); }
    }
    const calls = await records(fake.recordPath);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.pid).not.toBe(calls[1]!.pid);
    for (const [index, call] of calls.entries()) {
      expect(JSON.stringify([call.argv, call.stdin])).toContain(`prompt-${index + 1}`);
      expect(call.argv).not.toContain('--version');
      expect(call.argv).not.toContain('--help');
    }
  });

  it.each(PIN_AGENT_KINDS)('%s retains ownership until a child with ended output is reclaimed', async kind => {
    const { fake, agent, tmp } = await fixture(kind);
    const warnings = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await fake.setScript({ ...jsonlScript(kind, 'success'), holdAfterLines: true, closeStdoutAfterLines: true });
    const activeRuns = new ActiveRuns();
    const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({ agent, activeRuns, pool, postDoneExitGraceMs: 150 });
    const execution = await executor.submit({ scopeId: 'scope', policy: policy(tmp.workspace), stopGraceMs: 50 });
    const events: AgentEvent[] = [];
    const observed = deferred();
    const pending = (async () => {
      for await (const event of execution.subscribe()) {
        events.push(event);
        if (kind === 'kimi' ? 'resumeHandle' in event : event.type === 'done') observed.resolve();
      }
    })();
    try {
      await fake.waitReady();
      const pid = await readyPid(fake.readyPath);
      await fake.release();
      await observed.promise;
      expect(alive(pid)).toBe(true);
      expect(pool.snapshot().active).toBe(1);
      expect(activeRuns.get('scope')).toBeDefined();
      expect(await execution.run.waitForExit(20)).toBe(false);
      if (kind === 'kimi') {
        expect(events.some(e => e.type === 'done')).toBe(false);
        await execution.stop();
      }
      await execution.finished;
      await pending;
      expect(await execution.run.waitForExit(1000)).toBe(true);
      expect(alive(pid)).toBe(false);
      expect(pool.snapshot().active).toBe(0);
      expect(activeRuns.get('scope')).toBeUndefined();
      if (kind !== 'kimi') {
        expect(events.filter(e => e.type === 'done')).toHaveLength(1);
        expect(warnings).toHaveBeenCalledWith('run', 'post-done-exit-timeout', expect.objectContaining({ agent: kind, graceMs: 150 }));
      } else {
        expect(warnings).not.toHaveBeenCalledWith('run', 'post-done-exit-timeout', expect.anything());
      }
    } finally { await execution.stop(); }
  });

  it('isolates interleaved Codex profiles and resets per-run option overrides', async () => {
    const tmp = await createTmpProfile('codex-interleave-');
    cleanups.push(tmp);
    const parentEnv = { ...process.env };
    const setups = [];
    for (const label of ['A', 'B'] as const) {
      const fake = await installControlledKindCli(tmp.root, 'codex', label);
      const home = join(tmp.root, `home-${label}`);
      const profileDir = join(tmp.root, `profile-${label}`);
      await mkdir(home);
      await mkdir(profileDir);
      const profile = createDefaultProfileConfig({
        agentKind: 'codex', binaryPath: fake.path,
        accounts: { app: { id: `app-${label}`, secret: 'test-secret', tenant: 'feishu' } },
        codex: { binaryPath: fake.path, codexHome: home, inheritCodexHome: false, ignoreRules: label === 'A' },
      });
      const agent = createRuntimeAgent(profile, { profileDir, rootDir: tmp.root, profile: label });
      setups.push({ label, fake, home, agent });
    }
    for (const turn of [1, 2]) {
      for (const setup of setups) await setup.fake.setScript(jsonlScript('codex', 'success'));
      const runs = [];
      try {
        for (const setup of setups) {
          const opts = { runId: `codex-${setup.label}-${turn}`, prompt: `PROMPT_${setup.label}_${turn}`, cwd: tmp.workspace, stopGraceMs: 50,
            ...(turn === 1 ? { agentOptions: { ignoreRules: setup.label !== 'A' } } : {}) };
          await setup.agent.prepareRun?.(opts);
          const run = setup.agent.run(opts);
          runs.push({ setup, run, pending: collect(run.events) });
          await setup.fake.waitReady();
        }
        // Both children are alive together, with the completion order reversed each turn.
        for (const { setup } of runs) expect(alive(await readyPid(setup.fake.readyPath))).toBe(true);
        for (const index of turn === 1 ? [1, 0] : [0, 1]) {
          const { setup, run, pending } = runs[index]!;
          await setup.fake.release();
          const events = await pending;
          expect(answer(events)).toContain(`ANSWER_${setup.label}`);
          expect(answer(events)).not.toContain(`ANSWER_${setup.label === 'A' ? 'B' : 'A'}`);
          expect(events.filter(e => e.type === 'done')).toHaveLength(1);
          expect(events.some(e => 'resumeHandle' in e && e.resumeHandle === `thread-${setup.label}`)).toBe(true);
          expect(await run.waitForExit(1000)).toBe(true);
          const calls = await records(setup.fake.recordPath);
          expect(calls).toHaveLength(turn);
          const call = calls[turn - 1]!;
          expect(call.env.CODEX_HOME).toBe(setup.home);
          expect(call.env.LARK_CHANNEL_PROFILE).toBe(setup.label);
          expect(call.stdin).toContain(`PROMPT_${setup.label}_${turn}`);
          expect(call.argv.includes('--ignore-rules')).toBe(turn === 1 ? setup.label !== 'A' : setup.label === 'A');
          const state = JSON.parse(await readFile(join(setup.home, `run-${call.pid}.json`), 'utf8'));
          expect(state).toEqual(call);
        }
      } finally { await Promise.all(runs.map(({ run }) => run.stop())); }
    }
    expect(process.env).toEqual(parentEnv);
  });

  it.each(PIN_AGENT_KINDS)('%s waitForExit waits for real runner cleanup after terminal', async kind => {
    const { fake, agent, tmp } = await fixture(kind);
    const cleanupEntered = deferred();
    const releaseCleanup = deferred();
    const terminal = deferred();
    const realRunner = runner.runJsonlCli;
    // Keep the descriptor-created adapter, translator, child and runner intact.
    // Only the real cleanup callback boundary is gated, including Claude's file cleanup.
    vi.spyOn(runner, 'runJsonlCli').mockImplementation(input => realRunner({
      ...input,
      cleanup: async () => {
        cleanupEntered.resolve();
        await releaseCleanup.promise;
        await input.cleanup?.();
      },
    }));
    const activeRuns = new ActiveRuns();
    const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({ agent, activeRuns, pool, postDoneExitGraceMs: 1000 });
    const execution = await executor.submit({ scopeId: 'cleanup-scope', policy: policy(tmp.workspace), stopGraceMs: 50 });
    const run = execution.run;
    const events: AgentEvent[] = [];
    const pending = (async () => {
      for await (const event of execution.subscribe()) {
        events.push(event);
        if (event.type === 'done') terminal.resolve();
      }
    })();
    try {
      await fake.waitReady();
      const pid = await readyPid(fake.readyPath);
      await fake.release();
      await Promise.all([cleanupEntered.promise, terminal.promise]);
      expect(alive(pid)).toBe(false);
      expect(await run.waitForExit(20)).toBe(false);
      expect(pool.snapshot().active).toBe(1);
      expect(activeRuns.get('cleanup-scope')).toBeDefined();
      releaseCleanup.resolve();
      await execution.finished;
      await pending;
      expect(events.filter(e => e.type === 'done')).toHaveLength(1);
      expect(events.filter(e => e.type === 'error')).toEqual([]);
      expect(await run.waitForExit(1000)).toBe(true);
      expect(pool.snapshot().active).toBe(0);
      expect(activeRuns.get('cleanup-scope')).toBeUndefined();
    } finally { releaseCleanup.resolve(); await run.stop(); }
  });
});

interface CallRecord {
  argv: string[];
  stdin: string;
  pid: number;
  cwd: string;
  env: Record<string, string>;
}
async function records(path: string): Promise<CallRecord[]> {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
async function readyPid(path: string): Promise<number> { return Number(await readFile(path, 'utf8')); }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function policy(cwd: string): RunPolicyAllow {
  return {
    ok: true, prompt: 'hello', requestedCwd: cwd, cwdRealpath: cwd,
    accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
    access: { ok: true, reason: 'allowed-user' }, attachments: [],
    policyFingerprint: 'fp', expiresAt: Date.now() + 60000,
  };
}
