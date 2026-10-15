import { describe, expect, it } from 'vitest';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import {
  CONTINUE_HINT,
  NOTICE_MAX_BUTTON_STREAK,
  NoticeActionAuth,
  buildNoticeMarkdown,
  isContinuePrompt,
  noticeUsesButtons,
  planInterruptionNotice,
} from '../../../src/bot/interruption-notice';
import { interruptionNoticeCard } from '../../../src/card/templates';
import type { RunOutcome } from '../../../src/bot/run-outcome';
import { createTmpProfile } from '../../helpers/tmp-profile';

function interrupted(
  type: 'external-signal' | 'keepalive-restart' | 'user-stop' | 'superseded',
  by: 'new' | 'cd' = 'new',
): RunOutcome {
  if (type === 'superseded') {
    return {
      kind: 'interrupted',
      reason: { type: 'superseded', by },
      retriable: false,
      needsHuman: false,
    };
  }
  return {
    kind: 'interrupted',
    reason: { type },
    retriable: type !== 'user-stop',
    needsHuman: false,
  };
}

describe('interruption notice decision', () => {
  it('plans a continue notice for interrupted outcomes except user-stop and session switch', () => {
    expect(planInterruptionNotice(interrupted('external-signal'))).toEqual({ kind: 'continue' });
    expect(planInterruptionNotice(interrupted('keepalive-restart'))).toEqual({ kind: 'continue' });
    expect(planInterruptionNotice(interrupted('user-stop'))).toEqual({ kind: 'none' });
    expect(planInterruptionNotice(interrupted('superseded', 'new'))).toEqual({ kind: 'none' });
    expect(planInterruptionNotice(interrupted('superseded', 'cd'))).toEqual({ kind: 'none' });
  });

  it('plans a continue notice for retriable failed or partial, and auth for auth-required', () => {
    expect(planInterruptionNotice({
      kind: 'failed',
      cause: 'transient-upstream',
      retriable: true,
      needsHuman: false,
    })).toEqual({ kind: 'continue' });
    expect(planInterruptionNotice({
      kind: 'partial',
      retriable: true,
      needsHuman: false,
    })).toEqual({ kind: 'continue' });
    expect(planInterruptionNotice({
      kind: 'failed',
      cause: 'auth-required',
      retriable: false,
      needsHuman: true,
    })).toEqual({ kind: 'auth' });
    expect(planInterruptionNotice({
      kind: 'failed',
      cause: 'unclassified',
      retriable: false,
      needsHuman: false,
    })).toEqual({ kind: 'none' });
    expect(planInterruptionNotice({
      kind: 'completed',
      retriable: false,
      needsHuman: false,
    })).toEqual({ kind: 'none' });
  });

  it('treats 继续 / @bot 继续 as the continue prompt and other text as ordinary', () => {
    expect(isContinuePrompt('继续')).toBe(true);
    expect(isContinuePrompt('continue')).toBe(true);
    expect(isContinuePrompt('@_user_1 继续')).toBe(true);
    expect(isContinuePrompt('或 @bot 继续')).toBe(false);
    expect(isContinuePrompt('请继续改这个文件')).toBe(false);
  });

  it('uses buttons for the first three consecutive notices and plain text on the fourth', () => {
    expect(noticeUsesButtons(1)).toBe(true);
    expect(noticeUsesButtons(NOTICE_MAX_BUTTON_STREAK)).toBe(true);
    expect(noticeUsesButtons(NOTICE_MAX_BUTTON_STREAK + 1)).toBe(false);
  });

  it('mentions the initiator and tells the user they can @bot 继续', () => {
    const body = buildNoticeMarkdown({
      initiatorId: 'ou_init',
      requireBotMention: true,
      outcome: interrupted('external-signal'),
    });
    expect(body).toContain('<at id="ou_init"></at>');
    expect(body).toContain('@bot');
    expect(body).toContain('继续');
    expect(buildNoticeMarkdown({
      initiatorId: 'ou_init',
      requireBotMention: false,
      outcome: interrupted('external-signal'),
    })).not.toContain('@bot');
  });
});

describe('interruption notice actions', () => {
  it('signs continue without binding the clicker, and rejects replay, expiry, and fingerprint change', async () => {
    const tmp = await createTmpProfile('notice-auth-');
    const store = new CallbackNonceStore(`${tmp.profile}/nonces.json`);
    let now = 1_000;
    const auth = new NoticeActionAuth({
      secret: 'notice-secret',
      nonceStore: store,
      now: () => now,
      createNonce: () => 'nonce-1',
    });
    const token = auth.sign({
      turnId: 'turn-1',
      scope: 'oc_group',
      chatId: 'oc_group',
      action: 'notice.continue',
      policyFingerprint: 'fp-1',
      ttlMs: 60_000,
    });
    const first = auth.verify(token);
    expect(first).toMatchObject({
      ok: true,
      payload: { turnId: 'turn-1', action: 'notice.continue', policyFingerprint: 'fp-1' },
    });
    expect(auth.verify(token)).toMatchObject({ ok: false, reason: 'nonce-replay' });

    const expiredAuth = new NoticeActionAuth({
      secret: 'notice-secret',
      nonceStore: store,
      now: () => now,
      createNonce: () => 'nonce-2',
    });
    const expired = expiredAuth.sign({
      turnId: 'turn-1',
      scope: 'oc_group',
      chatId: 'oc_group',
      action: 'notice.continue',
      policyFingerprint: 'fp-1',
      ttlMs: 10,
    });
    now = 1_000_000;
    expect(expiredAuth.verify(expired)).toMatchObject({ ok: false, reason: 'expired' });
    await tmp.cleanup();
  });

  it('renders continue / dismiss buttons on the card', () => {
    const card = interruptionNoticeCard({
      body: `${CONTINUE_HINT} 或 @bot 继续`,
      continueToken: 'tok-c',
      dismissToken: 'tok-d',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('继续');
    expect(json).toContain('暂不');
    expect(json).toContain('notice.continue');
    expect(json).toContain('notice.dismiss');
    expect(json).toContain('tok-c');
  });
});
