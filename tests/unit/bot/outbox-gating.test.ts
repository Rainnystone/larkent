import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TURN_JOURNAL_SCHEMA_VERSION,
  TurnJournal,
  type TurnJournalEntry,
} from '../../../src/bot/turn-journal';
import { redeliverStagedReply } from '../../../src/bot/feishu-delivery';
import { createFakeChannel } from '../../helpers/fake-channel';
import {
  axiosErrno,
  axiosLike,
  sdkShapedSendError,
} from '../../helpers/sdk-feishu-errors';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(now = () => 1_760_000_000_000) {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-gating-'));
  dirs.push(dir);
  const file = join(dir, 'turn-journal.json');
  return { file, journal: new TurnJournal(file, { now }) };
}

function queued(overrides: Partial<TurnJournalEntry> = {}): Omit<TurnJournalEntry, 'updatedAt' | 'createdAt'> {
  return {
    turnId: 'turn-1',
    scope: 'oc_group',
    chatId: 'oc_group',
    messageIds: ['om_1'],
    senderId: 'ou_user',
    initiatorId: 'ou_user',
    status: 'queued',
    ...overrides,
  };
}

describe('per-item outbox (T13)', () => {
  it('J3: a settled entry with a stored reply is sent once per pass, not twice', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue({
      ...queued({ turnId: 'settled-reply' }),
      status: 'settled',
      outcome: { kind: 'completed', retriable: false, needsHuman: false },
      reply: {
        markdown: 'ONCE',
        replyTo: 'om_1',
        replyMode: 'text',
        deliveryId: 'reply:settled-reply',
      },
    });
    const resend = vi.fn(async (_entry: TurnJournalEntry) => true);
    await journal.redeliver({ resend });
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resend.mock.calls[0]?.[0]?.reply?.deliveryId).toBe('reply:settled-reply');
    expect(journal.get('settled-reply')?.reply?.state).toBe('sent');
    await journal.redeliver({ resend });
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('J2: a delivered reply is not sent again when the notice fails, including on the second recovery', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'both' }));
    journal.stageReply('both', {
      markdown: 'ANSWER',
      replyTo: 'om_1',
      replyMode: 'text',
      deliveryId: 'reply:both',
    });
    journal.stageNotice('both', {
      kind: 'continue',
      recipientChatId: 'oc_group',
      markdown: 'notice',
      deliveryId: 'notice:both',
    });
    const resend = vi.fn(async () => true);
    const resendNotice = vi.fn(async () => {
      throw sdkShapedSendError(
        'unknown',
        axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'),
      );
    });
    await journal.redeliver({ resend, resendNotice });
    expect(resend).toHaveBeenCalledTimes(1);
    expect(journal.get('both')?.reply?.state).toBe('sent');
    expect(journal.get('both')?.notice?.state).toBe('staged');

    await journal.redeliver({ resend, resendNotice });
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resendNotice).toHaveBeenCalledTimes(2);
  });

  it('J1: abandoning a notice leaves a staged reply to be delivered once, then the entry is prunable', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'abandoned' }));
    journal.stageReply('abandoned', {
      markdown: 'KEEP ME',
      replyTo: 'om_1',
      replyMode: 'text',
      deliveryId: 'reply:abandoned',
    });
    journal.stageNotice('abandoned', {
      kind: 'continue',
      recipientChatId: 'oc_group',
      markdown: 'notice',
      deliveryId: 'notice:abandoned',
    });
    journal.setContinuation('abandoned', 'abandoned', { noticeInvalidated: true });
    const resend = vi.fn(async () => true);
    const resendNotice = vi.fn(async () => true);
    await journal.redeliver({ resend, resendNotice });
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resendNotice).not.toHaveBeenCalled();
    const entry = journal.get('abandoned');
    expect(entry?.reply?.state).toBe('sent');
    expect(entry?.notice?.state).toBe('voided');
    expect(entry?.status).toBe('reply-delivered');
    await journal.redeliver({ resend, resendNotice });
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('stops the redelivery loop at the first link error and finishes the rest on the next pass', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'a', messageIds: ['om_a'] }));
    journal.stageReply('a', {
      markdown: 'A',
      replyTo: 'om_a',
      replyMode: 'text',
      deliveryId: 'reply:a',
    });
    journal.enqueue(queued({ turnId: 'b', messageIds: ['om_b'] }));
    journal.stageReply('b', {
      markdown: 'B',
      replyTo: 'om_b',
      replyMode: 'text',
      deliveryId: 'reply:b',
    });
    const attempted: string[] = [];
    const linkErr = sdkShapedSendError(
      'unknown',
      axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'),
    );
    const resend = vi.fn(async (entry: TurnJournalEntry) => {
      attempted.push(entry.turnId);
      if (entry.turnId === 'a') throw linkErr;
      return true;
    });
    await journal.redeliver({ resend });
    expect(attempted).toEqual(['a']);
    expect(journal.get('a')?.reply?.state).toBe('staged');
    expect(journal.get('b')?.reply?.state).toBe('staged');

    const retry = vi.fn(async (_entry: TurnJournalEntry) => true);
    await journal.redeliver({ resend: retry });
    expect(retry.mock.calls.map((call) => call[0]?.turnId)).toEqual(['a', 'b']);
    expect(journal.get('a')?.reply?.state).toBe('sent');
    expect(journal.get('b')?.reply?.state).toBe('sent');
  });

  it('loads an old shared-status journal and delivers each staged item once', async () => {
    const now = 1_760_000_000_000;
    const { file, journal } = await fixture(() => now);
    await writeFile(file, `${JSON.stringify({
      schemaVersion: TURN_JOURNAL_SCHEMA_VERSION,
      entries: [{
        turnId: 'legacy',
        scope: 'oc_group',
        chatId: 'oc_group',
        messageIds: ['om_1'],
        senderId: 'ou_user',
        initiatorId: 'ou_user',
        status: 'completed-undelivered',
        reply: {
          markdown: 'LEGACY',
          replyTo: 'om_1',
          replyMode: 'text',
          deliveryId: 'reply:legacy',
        },
        createdAt: now,
        updatedAt: now,
      }],
    })}\n`);
    await journal.load();
    const resend = vi.fn(async (_entry: TurnJournalEntry) => true);
    await journal.redeliver({ resend });
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resend.mock.calls[0]?.[0]?.reply?.deliveryId).toBe('reply:legacy');
    expect(journal.get('legacy')?.reply?.state).toBe('sent');
    await journal.redeliver({ resend });
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('does not redeliver a staged reply after /new voids the turn', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'void-me' }));
    journal.stageReply('void-me', {
      markdown: 'KEEP OUT',
      replyTo: 'om_1',
      replyMode: 'text',
      deliveryId: 'reply:void-me',
    });
    journal.voidScope('oc_group');
    const resend = vi.fn(async (_entry: TurnJournalEntry) => true);
    await journal.redeliver({ resend });
    expect(resend).not.toHaveBeenCalled();
    expect(journal.get('void-me')?.status).toBe('voided');
    expect(journal.get('void-me')?.reply?.state).toBe('voided');
  });
});

describe('gone-card same-card then uuid fallback', () => {
  it('uuid-sends with the stored deliveryId when the card is gone and cannot be patched', async () => {
    const channel = createFakeChannel({ botAppId: 'cli_bot' });
    channel.updateCard = async () => {
      throw sdkShapedSendError('unknown', axiosLike('message not found', {
        response: { status: 400, data: { code: 230025 } },
      }));
    };
    const result = await redeliverStagedReply({
      channel,
      entry: {
        turnId: 'gone',
        scope: 'oc_group',
        chatId: 'oc_group',
        messageIds: ['om_src'],
        senderId: 'ou_user',
        initiatorId: 'ou_user',
        status: 'completed-undelivered',
        reply: {
          markdown: 'FULL ANSWER',
          replyTo: 'om_src',
          replyMode: 'card',
          deliveryId: 'reply:gone',
          messageId: 'om_stream_gone',
          interactive: true,
        },
        createdAt: 1_760_000_000_000,
        updatedAt: 1_760_000_000_000,
      },
      botAppId: 'cli_bot',
      now: () => 1_760_000_000_000,
    });
    expect(result.delivered).toBe(true);
    expect(result.messageId).toBeTruthy();
    expect(result.messageId).not.toBe('om_stream_gone');
    expect(channel.sent).toHaveLength(1);
    expect(JSON.stringify(channel.sent[0]?.content)).toContain('FULL ANSWER');
    expect((channel.sent[0]?.options as { uuid?: string } | undefined)?.uuid).toBe('reply:gone');
  });
});
