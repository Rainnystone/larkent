import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { handleCardAction } from '../../../src/card/dispatcher';
import type { FakeAgentRun } from '../../helpers/fake-agent';
import { createUserActionHarness, userActionEvent } from '../../helpers/user-action-context';

const cleanups: Array<() => Promise<void>> = [];

describe('signed card callback dispatch', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('runs built-in command callbacks when the bridge token verifies', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop'),
    });

    expect(activeRun.stopped).toBe(true);
  });

  it('uses group access semantics inside a card-originated command', async () => {
    const h = await createHarness();
    h.controls.profileConfig.mode = 'personal';
    h.controls.profileConfig.access.allowedUsers = ['ou_operator'];
    h.controls.profileConfig.access.admins = ['ou_operator'];
    await h.dispatch({ cmd: 'doctor' });
    expect(JSON.stringify(h.channel.sent)).toContain('access: ok (allowed-admin)');
  });

  it('rejects built-in command callbacks when the bridge token does not verify', async () => {
    const h = await createHarness();
    const deniedRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', deniedRun);
    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop', { operatorOpenId: 'ou_other' }),
    });

    expect(deniedRun.stopped).toBe(false);
  });

  it('forwards signed bridge callbacks without leaking auth fields into the agent payload', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' });
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch(
      {
        __bridge_cb: true,
        bridge_token: h.token('agent_callback', { nonce: 'nonce-agent' }),
        choice: 'a',
      },
      { note: 'from form' },
    );

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a","form_value":{"note":"from form"}}');
    expect(queued[0]?.chatType).toBe('group');
  });

  it('queues a valid bridge callback while the configured workspace cannot answer', async () => {
    const h = await createHarness();
    h.controls.profileConfig.workspaces.default = h.tmp.workspace;
    h.activeRuns.register('oc_group', h.agent.run({ runId: 'run-active', prompt: 'running' }));
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const realpath = fs.realpath;
    const lookup = vi.spyOn(fs, 'realpath').mockImplementation(async (path, ...options) => {
      if (path === h.tmp.workspace) await blocked;
      return realpath(path, ...options);
    });
    syncBuiltinESMExports();
    const dispatch = h.dispatch({ __bridge_cb: true, bridge_token: h.token('agent_callback'), choice: 'a' });
    try {
      const result = await Promise.race([
        dispatch.then(() => 'queued'),
        new Promise<string>(resolve => setImmediate(() => resolve('waiting-for-workspace'))),
      ]);
      expect(result).toBe('queued');
      expect(h.pending.cancel('oc_group').map(msg => msg.content)).toEqual(['[card-click] {"choice":"a"}']);
    } finally {
      release();
      await dispatch;
      lookup.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('drops legacy Claude callback markers before command dispatch', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __claude_cb: true,
      cmd: 'stop',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });

  it('scopes topic-group callbacks by the carrier message thread_id', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    // The dispatcher must read items[0].thread_id from the raw message get to
    // compose the `${chatId}:${threadId}` scope. A regression here (e.g. using
    // channel.fetchMessage, whose normalized shape drops thread_id) would fall
    // back to the bare chatId and route the click into the wrong session.
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    h.activeRuns.register('oc_group:th_topic', h.agent.run({ runId: 'run-active', prompt: 'running' }));

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { nonce: 'nonce-topic', scope: 'oc_group:th_topic' }),
      choice: 'a',
    });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    const queued = h.pending.cancel('oc_group:th_topic');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a"}');
  });

  it('rejects bridge callbacks when callback auth is unavailable', async () => {
    const h = await createHarness({ callbackAuth: false });
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __bridge_cb: true,
      choice: 'unsafe',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });
});

async function createHarness(opts: { callbackAuth?: boolean; chatMode?: 'p2p' | 'group' | 'topic' } = {}) {
  const h = await createUserActionHarness(opts.chatMode);
  if (opts.callbackAuth === false) h.runtime.callbackAuth = undefined;
  cleanups.push(h.cleanup);
  return {
    ...h,
    token(action: string, overrides: { operatorOpenId?: string; nonce?: string; scope?: string } = {}) {
      return h.auth.sign({
        runId: 'run-active', scope: overrides.scope ?? 'oc_group', chatId: 'oc_group',
        operatorOpenId: overrides.operatorOpenId ?? 'ou_operator', action, policyFingerprint: 'fp-1', ttlMs: 60_000,
      });
    },
    async dispatch(value: Record<string, unknown>, formValue?: Record<string, unknown>) {
      await handleCardAction({ ...h.runtime, evt: userActionEvent(value, formValue) });
    },
  };
}
