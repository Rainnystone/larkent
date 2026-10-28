import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCardAction } from '../../../src/card/dispatcher';
import { log } from '../../../src/core/logger';
import type { FakeAgentRun } from '../../helpers/fake-agent';
import { createUserActionHarness, userActionEvent } from '../../helpers/user-action-context';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('card dispatcher access fence', () => {
  it('rejects a clicker who is not on the fence allowlists', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    await handleCardAction({ ...h.runtime, evt: userActionEvent({
      cmd: 'stop', __bridge_cb: true, bridge_token: h.token('stop'),
    }) });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(
      'cardAction',
      'skip-not-allowed-user',
      expect.objectContaining({ reason: 'denied-user' }),
    );
  });
});

async function createHarness() {
  const h = await createUserActionHarness();
  h.controls.profileConfig.access.fence = { enabled: true };
  h.controls.profileConfig.access.allowedUsers = ['ou_allowed'];
  cleanups.push(h.cleanup);
  return { ...h, token: (action: string) => h.auth.sign({
    runId: 'run-active', scope: 'oc_group', chatId: 'oc_group', operatorOpenId: 'ou_operator',
    action, policyFingerprint: 'fp-1', ttlMs: 60_000,
  }) };
}
