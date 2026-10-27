import { afterEach, describe, expect, it } from 'vitest';
import { handleCardAction } from '../../../src/card/dispatcher';
import { createUserActionHarness, userActionEvent } from '../../helpers/user-action-context';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('notice card dispatch', () => {
  it('lets an allowed non-initiator continue and rejects a fenced-out owner', async () => {
    const h = await harness({ fence: true });
    const seen: string[] = [];
    h.onNotice = (operatorId) => {
      seen.push(operatorId);
    };

    await h.dispatch('ou_mate', h.token());
    expect(seen).toEqual(['ou_mate']);

    await h.dispatch('ou_owner', h.token({ nonce: 'nonce-owner' }));
    expect(seen).toEqual(['ou_mate']);
    expect(h.actions).toEqual(['ou_mate']);
  });

  it('rejects a replayed nonce', async () => {
    const h = await harness();
    const token = h.token();
    await h.dispatch('ou_user', token);
    await h.dispatch('ou_user', token);
    expect(h.actions).toEqual(['ou_user']);
  });

  it('keeps a valid continue usable after a mismatched dismiss click', async () => {
    const h = await harness();
    const token = h.token();
    await h.dispatch('ou_user', token, 'notice.dismiss');
    expect(JSON.stringify(h.channel.sent)).toContain('此继续已失效。');
    await h.dispatch('ou_user', token);
    expect(h.actions).toEqual(['ou_user']);
  });

  it('keeps the existing invalid-click response for pre-deploy tokens', async () => {
    const h = await harness();
    await h.dispatch('ou_user', h.token().replace('.v2.', '.v1.'));
    expect(h.actions).toEqual([]);
    expect(JSON.stringify(h.channel.sent)).toContain('此继续已失效。');
  });

  it('rejects a continue whose policy fingerprint no longer matches', async () => {
    const h = await harness();
    h.journal.noteTurnMeta('turn-1', { policyFingerprint: 'fp-other' });
    await h.dispatch('ou_user', h.token());
    expect(h.actions).toEqual([]);
    expect(JSON.stringify(h.channel.sent)).toMatch(/失效/);
  });
});

async function harness(opts: { fence?: boolean } = {}) {
  const h = await createUserActionHarness();
  h.controls.profileConfig.access.fence = { enabled: opts.fence ?? false };
  h.controls.profileConfig.access.allowedUsers = ['ou_user', 'ou_mate'];
  h.journal.enqueue({
    turnId: 'turn-1', scope: 'oc_group', chatId: 'oc_group', messageIds: ['om_1'], senderId: 'ou_user',
    initiatorId: 'ou_user', status: 'notice-delivered', policyFingerprint: 'fp-1',
  });
  cleanups.push(h.cleanup);
  const actions: string[] = [];
  const state = {
    ...h, actions, onNotice: (_operatorId: string) => {},
    token(_overrides: { nonce?: string } = {}) {
      return h.runtime.noticeAuth!.sign({ turnId: 'turn-1', scope: 'oc_group', chatId: 'oc_group',
        action: 'notice.continue', policyFingerprint: 'fp-1', ttlMs: 60_000 });
    },
    async dispatch(operatorId: string, token: string, cmd = 'notice.continue') {
      await handleCardAction({ ...h.runtime, evt: userActionEvent({ cmd, notice_token: token }, undefined, operatorId) });
      for (const message of h.pending.cancel('oc_group')) {
        actions.push(message.senderId);
        state.onNotice(message.senderId);
      }
    },
  };
  return state;
}
