import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FEISHU_READBACK_MAX_PAGES,
  FEISHU_UUID_WINDOW_MS,
  readBackBotReply,
  redeliverStagedReply,
  recoveryAnswerCard,
} from '../../../src/bot/feishu-delivery';
import {
  noticeDeliveryKey,
  replyDeliveryKey,
  TurnJournal,
  type TurnJournalEntry,
} from '../../../src/bot/turn-journal';
import { createFakeChannel } from '../../helpers/fake-channel';

const APP = 'cli_bot';
const CHAT = 'oc_group';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('delivery keys', () => {
  it('is stable, persists across restart, and stays within 50 chars', async () => {
    const turnId = '2e1b7c9a-1111-4111-8111-aaaaaaaaaaaa';
    const key = replyDeliveryKey(turnId);
    expect(key).toBe(`reply:${turnId}`);
    expect(key.length).toBeLessThanOrEqual(50);
    expect(noticeDeliveryKey(turnId).length).toBeLessThanOrEqual(50);

    const dir = await mkdtemp(join(tmpdir(), 'delivery-id-'));
    dirs.push(dir);
    const file = join(dir, 'turn-journal.json');
    const journal = new TurnJournal(file, { now: () => 1_760_000_000_000 });
    await journal.load();
    journal.enqueue({
      turnId,
      scope: CHAT,
      chatId: CHAT,
      messageIds: ['om_src'],
      senderId: 'ou_user',
      initiatorId: 'ou_user',
      status: 'queued',
    });
    journal.stageReply(turnId, {
      markdown: 'ANSWER',
      replyTo: 'om_src',
      replyMode: 'text',
    });
    await journal.flush();

    const reloaded = new TurnJournal(file);
    await reloaded.load();
    expect(reloaded.get(turnId)?.reply?.deliveryId).toBe(key);
    expect(reloaded.get(turnId)?.reply?.deliveryId).toBe(replyDeliveryKey(turnId));
  });
});

describe('redeliverStagedReply', () => {
  it('resends a lost response with the same uuid and records the original message_id', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const first = await channel.send(CHAT, { markdown: 'ANSWER' }, { uuid: 'reply:lost', replyTo: 'om_src' });
    const entry = staged({
      turnId: 'lost',
      deliveryId: 'reply:lost',
      markdown: 'ANSWER',
    });

    const result = await redeliverStagedReply({
      channel,
      entry,
      botAppId: APP,
      now: () => entry.createdAt + 1_000,
    });

    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe(first.messageId);
    expect(channel.sent).toHaveLength(1);
  });

  it('does not treat the echoed duplicate body as the displayed message', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    await channel.send(CHAT, { markdown: 'ORIGINAL' }, { uuid: 'reply:body', replyTo: 'om_src' });
    const result = await redeliverStagedReply({
      channel,
      entry: staged({
        turnId: 'body',
        deliveryId: 'reply:body',
        markdown: 'CHANGED',
      }),
      botAppId: APP,
      now: () => 1_760_000_000_000,
    });

    expect(result.messageId).toBe(channel.sent[0] && (await idOf(channel)));
    expect(JSON.stringify(channel.sent[0]?.content)).toContain('ORIGINAL');
    expect(JSON.stringify(channel.sent[0]?.content)).not.toContain('CHANGED');
  });

  it('patches the same card replace-all and never sends a new message', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const card = await channel.send(CHAT, { card: recoveryAnswerCard('partial') }, { uuid: 'reply:card' });
    const result = await redeliverStagedReply({
      channel,
      entry: staged({
        turnId: 'card',
        deliveryId: 'reply:card',
        markdown: 'FULL ANSWER',
        replyMode: 'card',
        messageId: card.messageId,
      }),
      botAppId: APP,
      now: () => 1_760_000_000_000,
    });
    const again = await redeliverStagedReply({
      channel,
      entry: staged({
        turnId: 'card',
        deliveryId: 'reply:card',
        markdown: 'FULL ANSWER',
        replyMode: 'card',
        messageId: card.messageId,
      }),
      botAppId: APP,
      now: () => 1_760_000_000_000,
    });

    expect(result.delivered).toBe(true);
    expect(again.delivered).toBe(true);
    expect(channel.sent).toHaveLength(1);
    expect(channel.updatedCards.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain('FULL ANSWER');
  });

  it('does not patch a markdown or text receipt as an interactive card', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const posted = await channel.send(CHAT, { markdown: 'partial' }, { uuid: 'reply:md', replyTo: 'om_src' });
    const result = await redeliverStagedReply({
      channel,
      entry: staged({
        turnId: 'md',
        deliveryId: 'reply:md',
        markdown: 'FULL ANSWER',
        replyMode: 'markdown',
        messageId: posted.messageId,
      }),
      botAppId: APP,
      now: () => 1_760_000_000_000,
    });

    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe(posted.messageId);
    expect(channel.sent).toHaveLength(1);
    expect(channel.updatedCards).toHaveLength(0);
  });

  it('finds a landed reply by parent_id + app id + create_time after the uuid window', async () => {
    const channel = createFakeChannel({ botAppId: APP, now: () => 1_760_000_001_000 });
    await channel.send(CHAT, { markdown: 'LANDED' }, {
      uuid: 'reply:old',
      replyTo: 'om_src',
    });
    const sendsBefore = channel.sent.length;
    const result = await redeliverStagedReply({
      channel,
      entry: staged({
        turnId: 'old',
        deliveryId: 'reply:old',
        markdown: 'LANDED',
        createdAt: 1_760_000_000_000,
      }),
      botAppId: APP,
      now: () => 1_760_000_000_000 + FEISHU_UUID_WINDOW_MS + 1,
      sleep: async () => {},
    });

    expect(result.delivered).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(channel.sent).toHaveLength(sendsBefore);
  });

  it('sends exactly once when read-back finds no match outside the uuid window', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const result = await redeliverStagedReply({
      channel,
      entry: staged({
        turnId: 'fresh',
        deliveryId: 'reply:fresh',
        markdown: 'ONLY ONCE',
        createdAt: 1_000,
      }),
      botAppId: APP,
      now: () => 1_000 + FEISHU_UUID_WINDOW_MS + 1,
      sleep: async () => {},
    });

    expect(result.delivered).toBe(true);
    expect(channel.sent).toHaveLength(1);
    expect(JSON.stringify(channel.sent[0]?.content)).toContain('ONLY ONCE');
    expect(JSON.stringify(channel.sent[0]?.content)).not.toMatch(/reply:fresh|<!--|deliveryId/);
  });

  it('stops paging at the hard cap', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    let pages = 0;
    channel.rawClient.im.v1.message.list = async () => {
      pages += 1;
      return {
        data: {
          items: [{
            message_id: `om_noise_${pages}`,
            parent_id: 'om_other',
            create_time: '1760000001000',
            sender: { id: APP, sender_type: 'app' },
          }],
          has_more: true,
          page_token: `p${pages}`,
        },
      };
    };

    await redeliverStagedReply({
      channel,
      entry: staged({
        turnId: 'cap',
        deliveryId: 'reply:cap',
        markdown: 'cap',
        createdAt: 1_000,
      }),
      botAppId: APP,
      now: () => 1_000 + FEISHU_UUID_WINDOW_MS + 1,
      sleep: async () => {},
    });

    expect(pages).toBe(FEISHU_READBACK_MAX_PAGES);
  });
});

describe('readBackBotReply', () => {
  it('does not match another sender or a message before the turn start', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const listed = [
      {
        message_id: 'om_other_bot',
        parent_id: 'om_src',
        create_time: '1760000002000',
        sender: { id: 'cli_other', sender_type: 'app' },
      },
      {
        message_id: 'om_early',
        parent_id: 'om_src',
        create_time: '1759999990000',
        sender: { id: APP, sender_type: 'app' },
      },
    ];
    channel.rawClient.im.v1.message.list = async () => ({ data: { items: listed, has_more: false } });

    const found = await readBackBotReply({
      channel,
      chatId: CHAT,
      parentId: 'om_src',
      botAppId: APP,
      afterMs: 1_760_000_000_000,
    });
    expect(found).toEqual({ kind: 'none' });
  });
});

function staged(input: {
  turnId: string;
  deliveryId: string;
  markdown: string;
  replyMode?: string;
  messageId?: string;
  createdAt?: number;
}): TurnJournalEntry {
  const createdAt = input.createdAt ?? 1_760_000_000_000;
  return {
    turnId: input.turnId,
    scope: CHAT,
    chatId: CHAT,
    messageIds: ['om_src'],
    senderId: 'ou_user',
    initiatorId: 'ou_user',
    status: 'completed-undelivered',
    reply: {
      markdown: input.markdown,
      replyTo: 'om_src',
      replyMode: input.replyMode ?? 'text',
      deliveryId: input.deliveryId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
    },
    createdAt,
    updatedAt: createdAt,
  };
}

async function idOf(channel: ReturnType<typeof createFakeChannel>): Promise<string | undefined> {
  const listed = await channel.rawClient.im.v1.message.list({
    params: { container_id: CHAT, container_id_type: 'chat' },
  }) as { data?: { items?: Array<{ message_id?: string }> } };
  return listed.data?.items?.[0]?.message_id;
}
