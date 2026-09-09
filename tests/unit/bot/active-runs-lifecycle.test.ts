import { describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import type { AgentRun } from '../../../src/agent/types';

describe('ActiveRuns lifecycle', () => {
  it('waitForAll reports cleanup failures after every wait has settled', async () => {
    const active = new ActiveRuns();
    const failure = new Error('cleanup failed');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const a: AgentRun = { runId: 'a', events: (async function* () {})(), stop: async () => {}, waitForExit: async () => { throw failure; } };
    const b: AgentRun = { runId: 'b', events: (async function* () {})(), stop: async () => {}, waitForExit: async () => { await gate; return true; } };
    active.register('a', a);
    active.register('b', b);
    let complete = false;
    const result = active.waitForAll().then(() => { complete = true; return undefined; }, error => { complete = true; return error; });
    await Promise.resolve();
    expect(complete).toBe(false);
    release();
    expect(await result).toMatchObject({ errors: [failure] });
    expect(active.scopes()).toEqual(['a', 'b']);
  });
  it('interrupt retains ownership until the owner unregisters after settlement', async () => {
    const active = new ActiveRuns();
    let settle!: () => void;
    const gate = new Promise<void>(resolve => { settle = resolve; });
    const run: AgentRun = { runId: 'a', events: (async function* () {})(), stop: () => gate, waitForExit: async () => false };
    const handle = active.register('a', run);
    expect(active.interrupt('a')).toBe(true);
    expect(handle.interrupted).toBe(true);
    expect(active.get('a')).toBe(handle);
    expect(active.reserve('a')).toBeUndefined();
    settle();
    await gate;
    active.unregister('a', run);
    expect(active.get('a')).toBeUndefined();
  });

  it('stopAll waits for every run and reports failed settlement without clearing ownership', async () => {
    const active = new ActiveRuns();
    const failure = new Error('A cleanup failed');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const a: AgentRun = { runId: 'a', events: (async function* () {})(), stop: async () => { throw failure; }, waitForExit: async () => false };
    const b: AgentRun = { runId: 'b', events: (async function* () {})(), stop: async () => { await gate; active.unregister('b', b); }, waitForExit: async () => false };
    active.register('a', a);
    active.register('b', b);
    let complete = false;
    const result = active.stopAll().then(() => { complete = true; return undefined; }, error => { complete = true; return error; });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(active.get('a')?.run).toBe(a);
    expect(active.get('b')?.run).toBe(b);
    release();
    expect(await result).toMatchObject({ errors: [failure] });
    expect(active.get('a')?.run).toBe(a);
    expect(active.get('b')).toBeUndefined();
  });
});
