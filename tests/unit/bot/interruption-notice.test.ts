import { describe, expect, it } from 'vitest';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import {
  CONTINUE_HINT,
  NOTICE_MAX_BUTTON_STREAK,
  NoticeActionAuth,
  buildNoticeMarkdown,
  deliverInterruptionNotice,
  abandonExtraInstruction,
  continueExtraInstruction,
  isContinuePrompt,
  noticeUsesButtons,
  planInterruptionNotice,
  resolvedNoticeCard,
} from '../../../src/bot/interruption-notice';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { interruptionNoticeCard } from '../../../src/card/templates';
import type { RunOutcome } from '../../../src/bot/run-outcome';
import { createTmpProfile } from '../../helpers/tmp-profile';

function interrupted(
  type: 'external-signal' | 'reconnect-command' | 'user-stop' | 'superseded' | 'bridge-idle-watchdog' | 'runner-timeout' | 'policy-guard',
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
    retriable: type !== 'user-stop' && type !== 'policy-guard',
    needsHuman: false,
  };
}

describe('interruption notice decision', () => {
  it('plans a continue notice for interrupted outcomes except user-stop and session switch', () => {
    expect(planInterruptionNotice(interrupted('external-signal'))).toEqual({ kind: 'continue' });
    expect(planInterruptionNotice(interrupted('reconnect-command'))).toEqual({ kind: 'continue' });
    expect(planInterruptionNotice(interrupted('user-stop'))).toEqual({ kind: 'none' });
    expect(planInterruptionNotice(interrupted('policy-guard'))).toEqual({ kind: 'none' });
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
      retriable: true,
      needsHuman: false,
    })).toEqual({ kind: 'continue' });
    expect(planInterruptionNotice({
      kind: 'completed',
      retriable: false,
      needsHuman: false,
    })).toEqual({ kind: 'none' });
  });

  it('puts the interrupted turn user input on the resume extra instruction', () => {
    const outcome: RunOutcome = {
      kind: 'failed',
      cause: 'transient-upstream',
      retriable: true,
      needsHuman: false,
    };
    expect(continueExtraInstruction(outcome)).toContain('上游网络中断');
    expect(continueExtraInstruction(outcome)).not.toContain('原始输入');
    expect(continueExtraInstruction(outcome, '写两行短诗')).toContain('写两行短诗');
    expect(continueExtraInstruction(outcome, '  ')).not.toContain('原始输入');
    expect(continueExtraInstruction(outcome)).not.toContain('写两行短诗');
    expect(abandonExtraInstruction(outcome)).toContain('已放弃');
    expect(abandonExtraInstruction(outcome)).toContain('不得继续或重做');
    expect(abandonExtraInstruction(outcome)).not.toContain(CONTINUE_HINT);
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

  it('does not structurally @mention a bot initiator', () => {
    const body = buildNoticeMarkdown({
      initiatorId: 'ou_peer_bot',
      requireBotMention: true,
      outcome: interrupted('external-signal'),
      mentionInitiator: false,
    });
    expect(body).not.toMatch(/<at\b/);
    expect(body).toContain('上一轮未完成');
  });

  it('shows Chinese reasons on notice cards instead of internal outcome codes', () => {
    const idle = buildNoticeMarkdown({
      initiatorId: 'ou_init',
      requireBotMention: true,
      outcome: interrupted('bridge-idle-watchdog'),
    });
    expect(idle).toContain('空闲超时');
    expect(idle).not.toMatch(/interrupted:|failed:/);
    const transient = buildNoticeMarkdown({
      initiatorId: 'ou_init',
      requireBotMention: false,
      outcome: {
        kind: 'failed',
        cause: 'transient-upstream',
        retriable: true,
        needsHuman: false,
      },
    });
    expect(transient).toContain('上游网络中断');
    expect(transient).not.toMatch(/interrupted:|failed:/);
  });

  it('plans a continue notice after timeout so the timeout card plus notice is two messages by design', () => {
    expect(planInterruptionNotice(interrupted('runner-timeout'))).toEqual({ kind: 'continue' });
    expect(planInterruptionNotice(interrupted('bridge-idle-watchdog'))).toEqual({ kind: 'continue' });
  });
});

describe('interruption notice actions', () => {
  it('returns the turn, scope and policy claims without binding the clicker', async () => {
    const tmp = await createTmpProfile('notice-auth-');
    const store = new CallbackNonceStore(`${tmp.profile}/nonces.json`);
    try {
      const auth = new NoticeActionAuth({ secret: 'notice-secret', nonceStore: store,
        now: () => 1000, createNonce: () => 'nonce-1' });
      const token = auth.sign({ turnId: 'turn-1', scope: 'group:topic', chatId: 'group',
        action: 'notice.continue', policyFingerprint: 'policy-1', ttlMs: 60_000 });
      expect(auth.verify(token)).toEqual({ ok: true, payload: { turnId: 'turn-1', scope: 'group:topic',
        chatId: 'group', action: 'notice.continue', policyFingerprint: 'policy-1', exp: 61_000, nonce: 'nonce-1' } });
    } finally {
      await store.flush();
      await tmp.cleanup();
    }
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

  it('delivers a human-initiated notice with a structured @ and a bot-initiated notice without one', async () => {
    const interruptedOutcome: RunOutcome = {
      kind: 'interrupted',
      reason: { type: 'external-signal' },
      retriable: true,
      needsHuman: false,
    };
    const human = await noticeDelivery('ou_user');
    expect(noticeMarkdown(human.sent)).toContain('<at id="ou_user"></at>');
    const bot = await noticeDelivery('ou_peer_bot', 'bot');
    expect(noticeMarkdown(bot.sent)).not.toMatch(/<at\b/);
    expect(noticeMarkdown(bot.sent)).toContain('上一轮未完成');
    await human.cleanup();
    await bot.cleanup();

    async function noticeDelivery(initiatorId: string, initiatorType?: 'user' | 'bot') {
      const tmp = await createTmpProfile('notice-initiator-');
      const journal = new TurnJournal(`${tmp.profile}/turn-journal.json`);
      await journal.load();
      journal.enqueue({
        turnId: 'turn-1',
        scope: 'oc_group',
        chatId: 'oc_group',
        messageIds: ['om_1'],
        senderId: initiatorId,
        initiatorId,
        ...(initiatorType ? { initiatorType } : {}),
        status: 'queued',
      });
      const sent: unknown[] = [];
      await deliverInterruptionNotice({
        send: async (_chatId, content) => {
          sent.push(content);
          return { messageId: 'om_notice' };
        },
        journal,
        turnId: 'turn-1',
        outcome: interruptedOutcome,
        consecutive: 4,
        requireBotMention: true,
        authNotified: false,
      });
      return { sent, cleanup: tmp.cleanup };
    }

    function noticeMarkdown(sent: unknown[]): string {
      return sent.map((item) => {
        if (item && typeof item === 'object' && 'markdown' in item) {
          return String((item as { markdown: unknown }).markdown);
        }
        return JSON.stringify(item);
      }).join('\n');
    }
  });

  it('renders a resolved card without continue/dismiss buttons', () => {
    const continued = JSON.stringify(resolvedNoticeCard('continued'));
    expect(continued).toContain('已继续');
    expect(continued).not.toContain('notice.continue');
    expect(continued).not.toContain('暂不');
    const dismissed = JSON.stringify(resolvedNoticeCard('dismissed'));
    expect(dismissed).toContain('已忽略');
    expect(dismissed).not.toContain('notice.dismiss');
    const abandoned = JSON.stringify(resolvedNoticeCard('abandoned'));
    expect(abandoned).toContain('已放弃');
    expect(abandoned).not.toContain('notice.continue');
  });
});
