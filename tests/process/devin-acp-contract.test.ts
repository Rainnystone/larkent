import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevinAdapter } from '../../src/agent/devin/adapter';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../src/agent/types';
import { installDevinAcpCli } from '../helpers/devin-acp-cli';
import { reduce, seedRunState, shouldSkipFinalReply } from '../../src/card/run-state';
import { inspectAutomationToolUse } from '../../src/automations/policy-guard';
import { createIdleWatchdog, TOOL_IDLE_PAUSE_CAP_MS } from '../../src/bot/idle-watchdog';
import type { RunHandle } from '../../src/bot/active-runs';

const runs: AgentRun[] = [];
const dirs: string[] = [];
afterEach(async () => { await Promise.all(runs.splice(0).map(r => r.stop())); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); vi.unstubAllEnvs(); });
async function fixture(script: Record<string, unknown> = {}, profile: unknown = undefined) {
  const cwd = await mkdtemp(join(tmpdir(), 'devin-acp-')); dirs.push(cwd);
  const cli = await installDevinAcpCli(cwd, { lines: ['Intro\n\n    indented\n'], ...script });
  const adapter = new DevinAdapter({ binary: cli.binary, agentOptions: profile, stopGraceMs: 100 });
  return { cwd, cli, run(options: Partial<AgentRunOptions> = {}) { const r = adapter.run({ runId: 'test', prompt: 'hello', cwd, ...options }); runs.push(r); return r; }, report: async () => JSON.parse(await readFile(cli.recordPath, 'utf8')) };
}
async function collect(run: AgentRun) { const events: AgentEvent[] = []; for await (const e of run.events) events.push(e); return events; }

describe('DEVIN ACP adapter contract', () => {
  it('uses stdio ACP, applies permission first, preserves whitespace and records a handle', async () => {
    const f = await fixture(); const r = f.run(); const events = await collect(r);
    expect(events).toContainEqual({ type: 'final_text', content: 'Intro\n\n    indented\n' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'system', resumeHandle: 'fixture-session' }));
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal', resumeHandle: 'fixture-session' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'usage', inputTokens: 12, outputTokens: 3 }));
    expect((await f.report()).calls.map((c: any) => c.method)).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/prompt']);
    expect(await r.waitForExit(1000)).toBe(true); expect(r.exit).toBe(0);
  });
  it('reapplies lower permissions after load and suppresses replay', async () => {
    const f = await fixture({ replay: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD' } }] });
    const events = await collect(f.run({ resumeHandle: 'old-short-id', agentOptions: { permissionMode: 'plan', sandbox: 'read-only' } }));
    expect(JSON.stringify(events)).not.toContain('OLD');
    const calls = (await f.report()).calls;
    expect(calls[1]).toMatchObject({ method: 'session/load', params: { sessionId: 'old-short-id' } });
    expect(calls[2]).toMatchObject({ method: 'session/set_config_option', params: { configId: 'mode', value: 'ask' } });
  });
  it('preserves native sandbox despite generic workspace hints', async () => {
    const f = await fixture({}, { sandbox: true });
    await collect(f.run({ agentOptions: { sandbox: 'workspace-write' } }));
    const report = await f.report();
    expect(report.argv).toContain('--sandbox');
    expect(report.calls[2].params.value).toBe('autonomous');
  });
  it.each(['acceptEdits', 'default'])('rejects generic restricted mode %s that the sandbox cannot preserve', async permissionMode => {
    const f = await fixture({}, { sandbox: true });
    expect(() => f.run({ agentOptions: { sandbox: 'workspace-write', permissionMode } })).toThrow(/sandbox/i);
  });
  it('retains the sandbox implied by a profile autonomous mode under generic policy', async () => {
    const f = await fixture({}, { permissionMode: 'autonomous' });
    await collect(f.run({ agentOptions: { sandbox: 'danger-full-access', permissionMode: 'bypassPermissions' } }));
    expect((await f.report()).argv).toContain('--sandbox');
    expect((await f.report()).calls[2].params.value).toBe('autonomous');
  });
  it('inherits a native sandbox environment preference unless explicitly overridden', async () => {
    vi.stubEnv('DEVIN_SANDBOX', 'true');
    const f = await fixture(); await collect(f.run());
    expect((await f.report()).argv).toContain('--sandbox');
    const override = await fixture({}, { sandbox: false }); await collect(override.run());
    expect((await override.report()).argv).not.toContain('--sandbox');
  });
  it('clamps a permissive profile to read-only policy', async () => {
    const f = await fixture({}, { permissionMode: 'dangerous' });
    await collect(f.run({ agentOptions: { sandbox: 'read-only', permissionMode: 'plan' } }));
    expect((await f.report()).calls[2].params.value).toBe('ask');
  });
  it.each(['smart', 'accept-edits'])('does not silently widen sandboxed profile mode %s', async permissionMode => {
    const f = await fixture({}, { permissionMode, sandbox: true });
    expect(() => f.run({ agentOptions: { sandbox: 'workspace-write', permissionMode: 'acceptEdits' } })).toThrow(/sandbox/i);
  });
  it('delivers actual ACP tool events to message deduplication, auth guard and idle tracking', async () => {
    const f = await fixture({ updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'send', title: 'Send', kind: 'execute' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'send', status: 'in_progress', rawInput: { command: ['lark-cli','im','+messages-send','--chat-id','oc_fixture','--text','hello'] } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'send', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '{"code":0,"data":{"message_id":"om_fixture"}}' } }] },
      { sessionUpdate: 'tool_call', toolCallId: 'auth', title: 'Auth', kind: 'execute', rawInput: { command: 'lark-cli auth login' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'auth', status: 'failed', rawOutput: 'Rejected' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finished' } },
    ] });
    const run = f.run();
    const handle: RunHandle = { run, interrupted: false, lastEventAt: Date.now() };
    const watch = createIdleWatchdog({ handle, idleTimeoutMs: 60000 });
    let state = seedRunState({ currentChatId: 'oc_fixture' });
    const blocked: string[] = [];
    try {
      for await (const event of run.events) {
        state = reduce(state, event); watch.noteDelivered(event);
        if (event.type === 'tool_use') {
          expect(handle.hasOpenToolCall).toBe(true); expect(watch.armedDelayMs()).toBe(TOOL_IDLE_PAUSE_CAP_MS);
          const hit = inspectAutomationToolUse(event); if (hit) blocked.push(hit.reason);
        }
        if (event.type === 'tool_result') { expect(handle.hasOpenToolCall).toBe(false); expect(watch.armedDelayMs()).toBe(60000); }
      }
      expect(shouldSkipFinalReply(state, 'oc_fixture')).toBe(true);
      expect(blocked).toEqual(['auth-config']);
    } finally { watch.dispose(); }
  });
  it.each(['opus', 'swe-2-max'])('preserves explicit model %s when resuming', async model => {
    const f = await fixture(); await collect(f.run({ resumeHandle: 'old', model }));
    const calls = (await f.report()).calls;
    expect(calls).toContainEqual(expect.objectContaining({ method: 'session/set_config_option', params: expect.objectContaining({ configId: 'model', value: model === 'opus' ? 'claude-opus-5-5-medium' : 'swe-2-high' }) }));
    if (model === 'swe-2-max') expect(calls).toContainEqual(expect.objectContaining({ params: expect.objectContaining({ configId: 'thought_level', value: 'max' }) }));
  });
  it('restates thought_level when a resumed session leaves swe-2-max', async () => {
    const f = await fixture({ thoughtLevel: 'max' });
    await collect(f.run({ resumeHandle: 'old', model: 'swe-2-high' }));
    const calls = (await f.report()).calls;
    expect(calls).toContainEqual(expect.objectContaining({ method: 'session/set_config_option', params: expect.objectContaining({ configId: 'model', value: 'swe-2-high' }) }));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'session/set_config_option', params: expect.objectContaining({ configId: 'thought_level', value: 'high' }) }));
  });
  it.each([{ loadError: true }, { configError: true }, { malformed: true }])('fails rather than reporting success for %j', async script => {
    const f = await fixture(script); const events = await collect(f.run({ resumeHandle: 'missing' }));
    expect(events.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((await f.report()).calls.some((c: any) => c.method === 'session/new')).toBe(false);
  });
  it('rejects unexpected permission requests and reports blocked execution', async () => {
    const f = await fixture({ permission: true }); const events = await collect(f.run());
    expect(events.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed', message: expect.stringMatching(/permission/i) });
    expect((await f.report()).permissionResponse.result.outcome).toEqual({ outcome: 'selected', optionId: 'no' });
  });
  it('keeps stderr and exit status live after an abnormal exit', async () => {
    const f = await fixture({ stderr: 'x'.repeat(700) + 'ECONNRESET', exitCode: 17 }); const r = f.run();
    expect(r.exit).toBeUndefined(); await collect(r); expect(await r.waitForExit(1000)).toBe(true);
    expect(r.exit).toBe(17); expect(r.stderrSnapshot).toContain('ECONNRESET');
  });
  it('exposes leader exit before inherited stdout pipes have closed', async () => {
    const f = await fixture({ spawnDescendant: true, holdPipe: true, exitCode: 17 }); const r = f.run();
    const pending = collect(r);
    const until = Date.now() + 1500;
    while (r.exit === undefined && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    try {
      expect(r.exit).toBe(17);
      expect(await r.waitForExit(1)).toBe(false);
    } finally { await r.stop(); await pending; }
  });
  it('fails malformed tool notifications instead of silently losing tool visibility', async () => {
    const f = await fixture({ updates: [{ sessionUpdate: 'tool_call', title: 'Invalid call', kind: 'execute', rawInput: { command: 'lark-cli auth login' } }] });
    const events = await collect(f.run());
    expect(events.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });
  it('stops a silent pending next and settles before iterator return resolves', async () => {
    const f = await fixture({ hang: true, ignoreCancel: true, ignoreEof: true, ignoreTerm: true }); const r = f.run();
    const iterator = r.events[Symbol.asyncIterator]();
    // Consume the initial system handle; the next call then waits on silent stdout.
    await iterator.next(); const pending = iterator.next();
    expect(await r.waitForExit(1)).toBe(false);
    await iterator.return!(); await pending;
    expect(await r.waitForExit(1)).toBe(true); expect(r.signal).toBe('SIGKILL');
  });
  it('cleans up when the iterator is returned before its first next', async () => {
    const f = await fixture({ hang: true }); const r = f.run();
    await r.events[Symbol.asyncIterator]().return!();
    expect(await r.waitForExit(1)).toBe(true); expect(r.exit).not.toBeUndefined();
  });
  it('reclaims descendants even when EOF lets the leader exit immediately', async () => {
    const f = await fixture({ hang: true, spawnDescendant: true }); const r = f.run();
    const pending = collect(r);
    let pid = 0;
    const until = Date.now() + 3000;
    while (!pid && Date.now() < until) { pid = (await f.report().catch(() => ({}))).descendantPid ?? 0; if (!pid) await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(pid).toBeGreaterThan(0);
    try {
      await r.stop(); await pending;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await r.waitForExit(1)).toBe(true);
    } finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  it.skipIf(process.platform === 'win32').each(['stop', 'return'] as const)('reclaims a SIGTERM-resistant same-group child before %s settles', async action => {
    const f = await fixture({ hang: true, spawnDescendant: true, descendantIgnoreTerm: true }); const r = f.run();
    const iterator = r.events[Symbol.asyncIterator]();
    await iterator.next(); const pending = iterator.next();
    let pid = 0;
    const until = Date.now() + 3000;
    while (!pid && Date.now() < until) { pid = (await f.report().catch(() => ({}))).descendantPid ?? 0; if (!pid) await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(pid).toBeGreaterThan(0);
    try {
      if (action === 'stop') await r.stop(); else await iterator.return!();
      await pending;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await r.waitForExit(1)).toBe(true);
      await r.stop();
    } finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  it.skipIf(process.platform === 'win32')('preserves intentional background services after a normal turn', async () => {
    const f = await fixture({ spawnDescendant: true }); const r = f.run();
    await collect(r);
    const pid = (await f.report()).descendantPid;
    try {
      expect(await r.waitForExit(1)).toBe(true);
      await r.stop();
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  it('supports legacy modes only when configOptions is absent', async () => {
    const f = await fixture({ legacyModes: true }); await collect(f.run());
    expect((await f.report()).calls[2]).toMatchObject({ method: 'session/set_mode', params: { modeId: 'bypass' } });
  });
});
