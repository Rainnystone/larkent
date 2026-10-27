import { afterEach, describe, expect, it, vi } from 'vitest';
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

  describe('暂不 (dismiss)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('settles the clicked card through the callback response', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const h = await harness({ buttons: true });
      const response = await h.dispatch('ou_user', h.token({ action: 'notice.dismiss' }), 'notice.dismiss');
      const card = (response as { card?: { type?: unknown; data?: unknown } } | undefined)?.card;
      expect(card?.type).toBe('raw');
      const data = JSON.stringify(card?.data);
      expect(data).toContain('已忽略');
      expect(data).not.toContain('暂不');
      expect(data).not.toContain('notice.continue');
      expect(data).not.toContain('notice.dismiss');
      expect(h.actions).toEqual([]);
    });

    it('acknowledges without waiting on a card patch', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const h = await harness({ buttons: true });
      const patches: string[] = [];
      h.channel.updateCard = (messageId: string) => {
        patches.push(messageId);
        return new Promise<void>(() => {});
      };
      const response = await h.dispatch('ou_user', h.token({ action: 'notice.dismiss' }), 'notice.dismiss');
      expect(patches).toEqual([]);
      expect(JSON.stringify(response)).toContain('已忽略');
    });

    it('patches the notice to 已忽略 once, after the callback was acknowledged', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const h = await harness({ buttons: true });
      await h.dispatch('ou_user', h.token({ action: 'notice.dismiss' }), 'notice.dismiss');
      expect(h.channel.updatedCards).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_499);
      expect(h.channel.updatedCards).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.channel.updatedCards).toHaveLength(1);
      expect(h.channel.updatedCards[0]?.messageId).toBe('om_card');
      expect(JSON.stringify(h.channel.updatedCards[0]?.card)).toContain('已忽略');
      expect(JSON.stringify(h.channel.updatedCards[0]?.card)).not.toContain('notice.dismiss');
    });
  });
});

async function harness(opts: { fence?: boolean; buttons?: boolean } = {}) {
  const h = await createUserActionHarness();
  h.controls.profileConfig.access.fence = { enabled: opts.fence ?? false };
  h.controls.profileConfig.access.allowedUsers = ['ou_user', 'ou_mate'];
  h.journal.enqueue({
    turnId: 'turn-1', scope: 'oc_group', chatId: 'oc_group', messageIds: ['om_1'], senderId: 'ou_user',
    initiatorId: 'ou_user', status: 'notice-delivered', policyFingerprint: 'fp-1',
  });
  if (opts.buttons) {
    h.journal.recordNotice('turn-1', {
      kind: 'continue', recipientChatId: 'oc_group', markdown: '中断', includeButtons: true, messageId: 'om_card',
    });
  }
  cleanups.push(h.cleanup);
  const actions: string[] = [];
  const state = {
    ...h, actions, onNotice: (_operatorId: string) => {},
    token(overrides: { nonce?: string; action?: 'notice.continue' | 'notice.dismiss' } = {}) {
      return h.runtime.noticeAuth!.sign({ turnId: 'turn-1', scope: 'oc_group', chatId: 'oc_group',
        action: overrides.action ?? 'notice.continue', policyFingerprint: 'fp-1', ttlMs: 60_000 });
    },
    async dispatch(operatorId: string, token: string, cmd = 'notice.continue') {
      const response = await handleCardAction({ ...h.runtime, evt: userActionEvent({ cmd, notice_token: token }, undefined, operatorId) });
      for (const message of h.pending.cancel('oc_group')) {
        actions.push(message.senderId);
        state.onNotice(message.senderId);
      }
      return response;
    },
  };
  return state;
}
