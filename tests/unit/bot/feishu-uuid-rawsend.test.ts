import { describe, expect, it } from 'vitest';
import { createLarkChannel } from '@larksuite/channel';
import { axiosErrno } from '../../helpers/sdk-feishu-errors';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
};

describe('Feishu uuid on SDK rawSend', () => {
  it('retries an unknown error with the same uuid and keeps one chat message', async () => {
    const creates: Array<{ uuid?: string; content?: string }> = [];
    const chat: string[] = [];
    const byUuid = new Map<string, { id: string; content: string }>();
    const channel = stubbedChannel(async (params) => {
      const data = asRecord(asRecord(params)?.data);
      const uuid = typeof data?.uuid === 'string' ? data.uuid : undefined;
      const content = typeof data?.content === 'string' ? data.content : undefined;
      creates.push({ uuid, content });
      if (uuid && byUuid.has(uuid)) {
        const original = byUuid.get(uuid)!;
        return {
          data: {
            message_id: original.id,
            body: { content },
          },
        };
      }
      const id = `om_${chat.length + 1}`;
      if (uuid) byUuid.set(uuid, { id, content: content ?? '' });
      chat.push(id);
      if (creates.length === 1) {
        throw axiosErrno('ECONNRESET', 'socket hang up');
      }
      return { data: { message_id: id } };
    });

    const result = await channel.send('oc_test', { text: 'first' }, { uuid: 'reply:turn-1' });

    expect(creates.map((call) => call.uuid)).toEqual(['reply:turn-1', 'reply:turn-1']);
    expect(chat).toEqual(['om_1']);
    expect(result.messageId).toBe('om_1');
  });

  it('returns the original message_id and echoes new content on a duplicate uuid', async () => {
    const stored = new Map<string, { id: string; content: string }>();
    const echoes: string[] = [];
    const channel = stubbedChannel(async (params) => {
      const data = asRecord(asRecord(params)?.data);
      const uuid = typeof data?.uuid === 'string' ? data.uuid : undefined;
      const content = typeof data?.content === 'string' ? data.content : '';
      if (uuid && stored.has(uuid)) {
        const original = stored.get(uuid)!;
        echoes.push(content);
        return {
          data: {
            message_id: original.id,
            body: { content },
          },
        };
      }
      const id = 'om_orig';
      if (uuid) stored.set(uuid, { id, content });
      return { data: { message_id: id, body: { content } } };
    });

    const first = await channel.send('oc_test', { text: 'original' }, { uuid: 'reply:turn-2' });
    const second = await channel.send('oc_test', { text: 'changed' }, { uuid: 'reply:turn-2' });

    expect(first.messageId).toBe('om_orig');
    expect(second.messageId).toBe('om_orig');
    expect(echoes.some((body) => body.includes('changed'))).toBe(true);
    expect(stored.get('reply:turn-2')?.content).toContain('original');
  });
});

function stubbedChannel(
  create: (params: unknown) => Promise<unknown>,
): {
  send: (
    to: string,
    input: { text: string },
    opts?: { uuid?: string },
  ) => Promise<{ messageId: string }>;
} {
  const channel = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'test',
    outbound: { retry: { maxAttempts: 3, baseDelayMs: 1 } },
    logger: silentLogger as never,
  }) as unknown as {
    sender: { client: unknown };
    send: (
      to: string,
      input: { text: string },
      opts?: { uuid?: string },
    ) => Promise<{ messageId: string }>;
  };
  channel.sender.client = {
    im: {
      v1: {
        message: {
          create,
          reply: create,
        },
      },
    },
  };
  return channel;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}
