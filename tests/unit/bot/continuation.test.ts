import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { createContinuations } from '../../../src/bot/continuation';
import {
  ABANDON_HINT,
  CONTINUE_HINT,
} from '../../../src/bot/interruption-notice';
import type { RunOutcome } from '../../../src/bot/run-outcome';
import { TurnJournal } from '../../../src/bot/turn-journal';

const dirs: string[] = [];
const interrupted: RunOutcome = {
  kind: 'interrupted',
  reason: { type: 'external-signal' },
  retriable: true,
  needsHuman: false,
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Continuations', () => {
  it('abandons an ordinary follow-up, updates the card, and rejects a later click', async () => {
    const { journal, cards, continuations } = await setup();
    continuations.offer('turn-1', interrupted);

    const taken = await continuations.take('oc_group', [msg('请改另一个文件')]);
    expect(taken).toMatchObject({ kind: 'abandoned', turnId: 'turn-1' });
    if (taken.kind !== 'abandoned') throw new Error('expected abandoned');
    expect(taken.instruction).toContain(ABANDON_HINT);
    expect(taken.instruction).not.toContain(CONTINUE_HINT);
    expect(JSON.stringify(cards.at(-1))).toContain('已放弃');
    expect(continuations.click('turn-1')).toBe(false);
    expect(journal.get('turn-1')?.continuation?.status).toBe('abandoned');
  });

  it('resumes from a button click exactly once', async () => {
    const { continuations } = await setup();
    continuations.offer('turn-1', interrupted);

    expect(continuations.click('turn-1')).toBe(true);
    const taken = await continuations.take('oc_group', [msg('继续')]);
    expect(taken.kind).toBe('continue');
    if (taken.kind !== 'continue') throw new Error('expected continue');
    expect(taken.instruction).toContain(CONTINUE_HINT);
    expect(taken.resumeHandle).toBe('sess-1');
    expect(continuations.click('turn-1')).toBe(false);
    const again = await continuations.take('oc_group', [msg('继续')]);
    expect(again.kind).toBe('none');
  });

  it('resumes from typed 继续 exactly once', async () => {
    const { cards, continuations } = await setup();
    continuations.offer('turn-1', interrupted);

    const taken = await continuations.take('oc_group', [msg('继续')]);
    expect(taken.kind).toBe('continue');
    expect(JSON.stringify(cards.at(-1))).toContain('已继续');
    expect(continuations.click('turn-1')).toBe(false);
  });

  it('rebuilds offered state after a journal reload', async () => {
    const { file, journal, continuations } = await setup();
    continuations.offer('turn-1', interrupted);
    await journal.flush();

    const reloaded = new TurnJournal(file);
    await reloaded.load();
    const cards: object[] = [];
    const next = createContinuations({
      journal: reloaded,
      updateCard: async (_id, card) => {
        cards.push(card);
      },
    });
    const taken = await next.take('oc_group', [msg('请改另一个文件')]);
    expect(taken.kind).toBe('abandoned');
    expect(JSON.stringify(cards.at(-1))).toContain('已放弃');
    expect(next.click('turn-1')).toBe(false);
  });

  it('still injects the abandon instruction after 暂不, without rewriting the card to 已放弃', async () => {
    const { cards, continuations } = await setup();
    continuations.offer('turn-1', interrupted);
    continuations.dismiss('turn-1');
    expect(continuations.click('turn-1')).toBe(false);

    const taken = await continuations.take('oc_group', [msg('请改另一个文件')]);
    expect(taken.kind).toBe('abandoned');
    if (taken.kind !== 'abandoned') throw new Error('expected abandoned');
    expect(taken.instruction).toContain(ABANDON_HINT);
    expect(taken.instruction).not.toContain(CONTINUE_HINT);
    expect(cards).toEqual([]);
  });

  it('voids an offer so a later click is stale', async () => {
    const { continuations } = await setup();
    continuations.offer('turn-1', interrupted);
    continuations.voidScope('oc_group');
    expect(continuations.click('turn-1')).toBe(false);
    const taken = await continuations.take('oc_group', [msg('继续')]);
    expect(taken.kind).toBe('none');
  });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'continuation-'));
  dirs.push(dir);
  const file = join(dir, 'turn-journal.json');
  const journal = new TurnJournal(file);
  await journal.load();
  journal.enqueue({
    turnId: 'turn-1',
    scope: 'oc_group',
    chatId: 'oc_group',
    messageIds: ['om_1'],
    senderId: 'ou_user',
    initiatorId: 'ou_user',
    status: 'notice-delivered',
    resumeHandle: 'sess-1',
    userInput: 'SECRET_PROMPT_TOKEN',
    outcome: interrupted,
    notice: {
      kind: 'continue',
      recipientChatId: 'oc_group',
      markdown: '上一轮未完成',
      includeButtons: true,
      messageId: 'om_notice',
    },
  });
  const cards: object[] = [];
  const continuations = createContinuations({
    journal,
    updateCard: async (_id, card) => {
      cards.push(card);
    },
  });
  return { file, journal, cards, continuations };
}

function msg(content: string): NormalizedMessage {
  return {
    messageId: 'om_follow',
    chatId: 'oc_group',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
  } as unknown as NormalizedMessage;
}
