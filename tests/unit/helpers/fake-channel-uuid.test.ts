import { describe, expect, it } from 'vitest';
import { createFakeChannel } from '../../helpers/fake-channel';

const APP = 'cli_bot';
const CHAT = 'oc_group';

describe('SDK-faithful fake Feishu uuid and list', () => {
  it('dedupes uuid: original message_id comes back and the chat holds one message', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const first = await channel.send(CHAT, { markdown: 'hello' }, { uuid: 'reply:t', replyTo: 'om_src' });
    const second = await channel.send(CHAT, { markdown: 'hello again' }, { uuid: 'reply:t', replyTo: 'om_src' });

    expect(second.messageId).toBe(first.messageId);
    expect(channel.sent).toHaveLength(1);
    expect(JSON.stringify(channel.sent[0]?.content)).toContain('hello');
    expect(JSON.stringify(channel.sent[0]?.content)).not.toContain('hello again');
  });

  it('echoes the new body on a duplicate uuid while storing the original', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const first = await channel.rawClient.im.v1.message.create({
      data: {
        receive_id: CHAT,
        msg_type: 'text',
        content: JSON.stringify({ text: 'original' }),
        uuid: 'reply:echo',
      },
    }) as { data?: { message_id?: string } };
    const echoed = await channel.rawClient.im.v1.message.create({
      data: {
        receive_id: CHAT,
        msg_type: 'text',
        content: JSON.stringify({ text: 'changed' }),
        uuid: 'reply:echo',
      },
    }) as { data?: { message_id?: string; body?: { content?: string } } };

    expect(echoed.data?.message_id).toBe(first.data?.message_id);
    expect(echoed.data?.body?.content).toContain('changed');
    expect(JSON.stringify(channel.sent[0]?.content)).toContain('original');
    expect(JSON.stringify(channel.sent[0]?.content)).not.toContain('changed');
  });

  it('lists messages without uuid and with the bot app id as sender', async () => {
    const channel = createFakeChannel({ botAppId: APP, now: () => 1_760_000_000_000 });
    await channel.send(CHAT, { markdown: 'listed' }, { uuid: 'reply:list', replyTo: 'om_src' });

    const listed = await channel.rawClient.im.v1.message.list({
      params: { container_id: CHAT, container_id_type: 'chat' },
    }) as { data?: { items?: Array<Record<string, unknown>> } };
    const item = listed.data?.items?.[0];
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('uuid');
    expect(JSON.stringify(item)).not.toContain('reply:list');
    expect(item?.parent_id).toBe('om_src');
    expect(asRecord(item?.sender)?.id).toBe(APP);
    expect(asRecord(item?.sender)?.sender_type).toBe('app');
  });

  it('patches the same interactive card twice without creating a new message', async () => {
    const channel = createFakeChannel({ botAppId: APP });
    const sent = await channel.send(CHAT, { card: { schema: '2.0', body: { elements: [] } } }, {
      uuid: 'reply:card',
    });
    await channel.updateCard(sent.messageId, { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'ONE' }] } });
    await channel.updateCard(sent.messageId, { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'FULL' }] } });

    expect(channel.sent).toHaveLength(1);
    expect(channel.updatedCards).toHaveLength(2);
    expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain('FULL');
  });
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}
