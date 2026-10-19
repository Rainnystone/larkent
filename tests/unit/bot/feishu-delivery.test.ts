import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FEISHU_READBACK_MAX_PAGES,
  FEISHU_READBACK_PAGE_SIZE,
  FEISHU_UUID_WINDOW_MS,
  readBackBotReply,
  redeliverStagedReply,
  recoveryAnswerCard,
} from '../../../src/bot/feishu-delivery';
import {
  noticeDeliveryKey,
  replyDeliveryKey,
  streamDeliveryKey,
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
  it('keeps the stream uuid distinct from the gone-card reply uuid', () => {
    const turnId = '2e1b7c9a-1111-4111-8111-aaaaaaaaaaaa';
    expect(streamDeliveryKey(turnId)).toBe(`stream:${turnId}`);
    expect(streamDeliveryKey(turnId)).not.toBe(replyDeliveryKey(turnId));
    expect(streamDeliveryKey(turnId).length).toBeLessThanOrEqual(50);
  });

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
  it('does not list the chat for a top-level fire outside the uuid window', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const createdAt = 1_000;
    const result = await redeliverStagedReply({
      channel,
      entry: staged({
        turnId: 'af:1@1000',
        deliveryId: 'reply:af:1@1000',
        markdown: '⏰ ping：x',
        replyTo: '',
        createdAt,
      }),
      botAppId: APP,
      now: () => createdAt + FEISHU_UUID_WINDOW_MS + 1,
      sleep: async () => {
        throw new Error('top-level fire must not wait for list visibility');
      },
    });
    expect(result.delivered).toBe(true);
    expect(channel.rawClient.requests.some((row) => row.method === 'im.v1.message.list')).toBe(false);
    expect(channel.sent).toHaveLength(1);
    expect((channel.sent[0]?.options as { replyTo?: string } | undefined)?.replyTo).toBeUndefined();
  });

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

  it('does not uuid-send when a rejected patch is not a gone card', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const card = await channel.send(CHAT, { card: recoveryAnswerCard('partial') }, { uuid: 'reply:kept' });
    channel.updateCard = async () => {
      throw Object.assign(new Error('Request failed with status code 400'), {
        cause: { response: { status: 400 } },
      });
    };
    const before = channel.sent.length;
    await expect(redeliverStagedReply({
      channel,
      entry: staged({
        turnId: 'kept',
        deliveryId: 'reply:kept',
        markdown: 'FULL ANSWER',
        replyMode: 'card',
        messageId: card.messageId,
        interactive: true,
      }),
      botAppId: APP,
      now: () => 1_760_000_000_000,
    })).rejects.toMatchObject({ message: expect.stringContaining('400') });
    expect(channel.sent).toHaveLength(before);
  });

  it('does not uuid-send when a rejected patch is 230002 not-in-chat', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const card = await channel.send(CHAT, { card: recoveryAnswerCard('partial') }, { uuid: 'reply:left' });
    channel.updateCard = async () => {
      throw Object.assign(new Error('The bot can not be outside the group'), {
        cause: { response: { status: 400, data: { code: 230002 } } },
      });
    };
    const before = channel.sent.length;
    await expect(redeliverStagedReply({
      channel,
      entry: staged({
        turnId: 'left',
        deliveryId: 'reply:left',
        markdown: 'FULL ANSWER',
        replyMode: 'card',
        messageId: card.messageId,
        interactive: true,
      }),
      botAppId: APP,
      now: () => 1_760_000_000_000,
    })).rejects.toMatchObject({
      cause: { response: { data: { code: 230002 } } },
    });
    expect(channel.sent).toHaveLength(before);
  });

  it('uuid-sends with reply:<turnId> when a gone card has no stored deliveryId', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    channel.updateCard = async () => {
      throw Object.assign(new Error('message not found'), {
        cause: { response: { status: 400, data: { code: 230025 } } },
      });
    };
    const result = await redeliverStagedReply({
      channel,
      entry: staged({
        turnId: '2e1b7c9a-1111-4111-8111-aaaaaaaaaaaa',
        markdown: 'FULL ANSWER',
        replyMode: 'card',
        messageId: 'om_gone_missing',
        interactive: true,
      }),
      botAppId: APP,
      now: () => 1_760_000_000_000,
    });
    expect(result.delivered).toBe(true);
    expect(channel.sent).toHaveLength(1);
    expect((channel.sent[0]?.options as { uuid?: string } | undefined)?.uuid).toBe(
      replyDeliveryKey('2e1b7c9a-1111-4111-8111-aaaaaaaaaaaa'),
    );
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

  it('patches a markdown stream receipt because it is an interactive card', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const streamId = 'om_md_stream';
    await channel.updateCard(streamId, recoveryAnswerCard('partial'));
    const result = await redeliverStagedReply({
      channel,
      entry: staged({
        turnId: 'md-stream',
        deliveryId: 'reply:md-stream',
        markdown: 'FULL ANSWER',
        replyMode: 'markdown',
        messageId: streamId,
        interactive: true,
      }),
      botAppId: APP,
      now: () => 1_760_000_000_000,
    });

    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe(streamId);
    expect(channel.sent).toHaveLength(0);
    expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain('FULL ANSWER');
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
  it('does not treat an unrecorded aux text reply as the landed answer', async () => {
    const channel = createFakeChannel({ botAppId: APP, now: () => 1_760_000_001_000 });
    const aux = await channel.send(CHAT, { markdown: 'WORKING…' }, { replyTo: 'om_src' });
    const found = await readBackBotReply({
      channel,
      chatId: CHAT,
      parentId: 'om_src',
      botAppId: APP,
      afterMs: 1_760_000_000_000,
      markdown: 'ANSWER',
    });
    expect(aux.messageId).toBeTruthy();
    expect(found).toEqual({ kind: 'none' });
  });

  it('skips known non-answer ids and still finds the final answer', async () => {
    const channel = createFakeChannel({ botAppId: APP, now: () => 1_760_000_001_000 });
    const notice = await channel.send(CHAT, { markdown: 'COT 过程消息更新失败' }, { replyTo: 'om_src' });
    const answer = await channel.send(CHAT, { markdown: 'ANSWER' }, { replyTo: 'om_src' });
    const found = await readBackBotReply({
      channel,
      chatId: CHAT,
      parentId: 'om_src',
      botAppId: APP,
      afterMs: 1_760_000_000_000,
      markdown: 'ANSWER',
      excludeIds: new Set([notice.messageId]),
    });
    expect(found).toEqual({ kind: 'text', messageId: answer.messageId });
  });

  it('does not treat a newer distractor notice as the landed answer after the uuid window', async () => {
    let now = 1_760_000_000_000;
    const channel = createFakeChannel({ botAppId: APP, now: () => now });
    const answer = await channel.send(CHAT, { markdown: 'ANSWER' }, {
      uuid: 'reply:distract',
      replyTo: 'om_src',
    });
    now += 1_000;
    const notice = await channel.send(CHAT, { markdown: '上一轮未完成' }, { replyTo: 'om_src' });
    const result = await redeliverStagedReply({
      channel,
      entry: {
        ...staged({
          turnId: 'distract',
          deliveryId: 'reply:distract',
          markdown: 'ANSWER',
          createdAt: 1_760_000_000_000,
        }),
        nonAnswerIds: [notice.messageId],
      },
      botAppId: APP,
      now: () => 1_760_000_000_000 + FEISHU_UUID_WINDOW_MS + 1,
      sleep: async () => {},
    });
    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe(answer.messageId);
    expect(channel.sent).toHaveLength(2);
  });

  it('does not use the parent message id as a thread container', async () => {
    const listed: Array<{ type?: unknown; id?: unknown }> = [];
    const channel = createFakeChannel({ botAppId: APP });
    channel.rawClient.im.v1.message.list = async (params: unknown) => {
      const nested = asListParams(params);
      listed.push({ type: nested.container_id_type, id: nested.container_id });
      return { data: { items: [], has_more: false } };
    };
    const found = await readBackBotReply({
      channel,
      chatId: CHAT,
      parentId: 'om_src',
      botAppId: APP,
      afterMs: 1_760_000_000_000,
      replyInThread: true,
      markdown: 'ANSWER',
    });
    expect(found).toEqual({ kind: 'none' });
    expect(listed).toEqual([]);
  });

  it('omits time-range parameters when reading back a thread container', async () => {
    const listed: Record<string, unknown>[] = [];
    const channel = createFakeChannel({ botAppId: APP });
    channel.rawClient.im.v1.message.list = async (params: unknown) => {
      listed.push(asListParams(params));
      return { data: { items: [], has_more: false } };
    };
    const found = await readBackBotReply({
      channel,
      chatId: CHAT,
      parentId: 'om_src',
      botAppId: APP,
      afterMs: 1_760_000_000_000,
      replyInThread: true,
      threadId: 'omt_topic',
      markdown: 'ANSWER',
    });
    expect(found).toEqual({ kind: 'none' });
    expect(listed).toEqual([{
      container_id_type: 'thread',
      container_id: 'omt_topic',
      sort_type: 'ByCreateTimeDesc',
      page_size: FEISHU_READBACK_PAGE_SIZE,
    }]);
  });

  it('reads a replyInThread answer from the thread container after the uuid window', async () => {
    const createdAt = 1_760_000_000_000;
    const channel = createFakeChannel({ botAppId: APP, now: () => createdAt + 1_000 });
    channel.rawThreadIds.set('om_src', 'omt_topic');
    const posted = await channel.send(CHAT, { markdown: 'THREAD_ANSWER' }, {
      uuid: 'reply:thread',
      replyTo: 'om_src',
      replyInThread: true,
    });
    const result = await redeliverStagedReply({
      channel,
      entry: {
        ...staged({
          turnId: 'thread',
          deliveryId: 'reply:thread',
          markdown: 'THREAD_ANSWER',
          createdAt,
        }),
        threadId: 'omt_topic',
        reply: {
          markdown: 'THREAD_ANSWER',
          replyTo: 'om_src',
          replyMode: 'text',
          deliveryId: 'reply:thread',
          replyInThread: true,
        },
      },
      botAppId: APP,
      now: () => createdAt + FEISHU_UUID_WINDOW_MS + 1,
      sleep: async () => {},
    });
    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe(posted.messageId);
    expect(channel.sent).toHaveLength(1);
  });

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
  deliveryId?: string;
  markdown: string;
  replyTo?: string;
  replyMode?: string;
  messageId?: string;
  interactive?: boolean;
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
      replyTo: input.replyTo ?? 'om_src',
      replyMode: input.replyMode ?? 'text',
      ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.interactive === true ? { interactive: true } : {}),
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

function asListParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object') return {};
  const rec = params as Record<string, unknown>;
  const nested = rec.params;
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  return rec;
}
