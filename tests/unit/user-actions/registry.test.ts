import { describe, expect, it } from 'vitest';
import { cardActionMessage } from '../../../src/user-actions/message';

describe('user action invocation', () => {
  it.each(['group', 'topic'] as const)('carries the real chat type for a %s card command', (mode) => {
    const msg = cardActionMessage({
      chatId: 'chat-test', messageId: 'card-test',
      operator: { openId: 'actor-test', name: 'Actor' },
      action: { tag: 'button', value: { cmd: 'help' } },
    }, mode, mode === 'topic' ? 'thread-test' : undefined);
    expect(msg).toMatchObject({ chatType: 'group', senderId: 'actor-test', rawContentType: 'interactive' });
    expect(msg.threadId).toBe(mode === 'topic' ? 'thread-test' : undefined);
  });
});

describe('declared user actions', () => {
  it('declares unsigned configuration, account and workspace actions explicitly', async () => {
    const { resolveCardUserAction, resolveSlashUserAction } = await import('../../../src/user-actions/registry');
    for (const cmd of ['config.submit', 'config.cancel', 'account.change', 'account.submit', 'account.cancel', 'ws.use', 'ws.remove']) {
      expect(resolveCardUserAction({ cmd })?.auth).toEqual({ kind: 'fence-only' });
    }
    expect(resolveSlashUserAction('/help')?.auth).toEqual({ kind: 'fence-only' });
    expect(resolveCardUserAction({ cmd: 'notice.continue' })?.auth).toEqual({ kind: 'signed', purpose: 'interruption-notice' });
    expect(resolveCardUserAction({ cmd: 'auto.confirm' })?.auth).toEqual({ kind: 'signed', purpose: 'automation-confirm' });
    expect(resolveCardUserAction({ cmd: 'auto.pause' })?.auth).toEqual({ kind: 'signed', purpose: 'automation-board' });
    expect(resolveCardUserAction({ __bridge_cb: true })?.auth).toEqual({ kind: 'signed', purpose: 'bridge-callback' });
  });
});

it('keeps unknown slash commands available to the agent', async () => {
  const { resolveSlashUserAction } = await import('../../../src/user-actions/registry');
  expect(resolveSlashUserAction('/history')).toBeUndefined();
  expect(resolveSlashUserAction('/model')).toBeUndefined();
  expect(resolveSlashUserAction('/resume')).toBeDefined();
  expect(resolveSlashUserAction('/status')).toBeDefined();
});

it.each([
  [{ cmd: 'notice.continue', notice_token: 'bad' }, '此继续已失效。'],
  [{ cmd: 'auto.confirm', auto_token: 'bad' }, '此确认已失效'],
  [{ cmd: 'auto.pause', auto_token: 'bad' }, '此确认已失效'],
  [{ __bridge_cb: true, bridge_token: 'bad', choice: 'x' }, undefined],
] as const)('keeps the invalid response for a signed action %j', async (payload, hint) => {
  const { createUserActionHarness, userActionEvent } = await import('../../helpers/user-action-context');
  const { handleCardAction } = await import('../../../src/card/dispatcher');
  const h = await createUserActionHarness();
  try {
    h.controls.profileConfig.automations.enabled = true;
    const response = await handleCardAction({ ...h.runtime, evt: userActionEvent(payload) });
    if (hint) expect(JSON.stringify([response, h.channel.sent])).toContain(hint);
    else expect(h.channel.sent).toEqual([]);
    expect(h.pending.cancel('oc_group')).toEqual([]);
  } finally { await h.cleanup(); }
});
