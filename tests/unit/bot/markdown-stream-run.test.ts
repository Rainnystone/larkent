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

describe('markdown stream run() reports the last flush error', () => {
  it('rejects with the last update error instead of swallowing it', async () => {
    const flushErr = axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443');
    const channel = stubbedMarkdownStream(flushErr);

    await expect(channel.stream('oc_test', {
      markdown: async (ctrl) => {
        await ctrl.setContent('PARTIAL');
      },
    })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBe(flushErr);
      return true;
    });
  });
});

function stubbedMarkdownStream(flushErr: Error): {
  stream: (
    to: string,
    input: { markdown: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void> },
  ) => Promise<{ messageId: string }>;
} {
  let sequence = 0;
  const channel = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'test',
    outbound: { retry: { maxAttempts: 1 } },
    logger: silentLogger as never,
  }) as unknown as {
    sender: { client: unknown };
    stream: (
      to: string,
      input: { markdown: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void> },
    ) => Promise<{ messageId: string }>;
  };
  channel.sender.client = {
    cardkit: {
      v1: {
        card: {
          create: async () => ({ data: { card_id: 'card_md' } }),
          update: async () => ({}),
          settings: async () => ({}),
        },
        cardElement: {
          content: async () => {
            sequence += 1;
            if (sequence > 0) throw flushErr;
            return {};
          },
        },
      },
    },
    im: {
      v1: {
        message: {
          create: async () => ({ data: { message_id: 'om_md_stream' } }),
          reply: async () => ({ data: { message_id: 'om_md_stream' } }),
          patch: async () => ({}),
        },
      },
    },
  };
  return channel;
}
