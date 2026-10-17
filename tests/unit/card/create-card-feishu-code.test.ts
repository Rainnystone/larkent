import { createLarkChannel } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import { readCardApiError } from '../../../src/card/card-api-error';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
};

describe('createCard Feishu code', () => {
  it('keeps cardkit code 200610 and msg when create returns no card_id', async () => {
    const channel = createLarkChannel({
      appId: 'cli_test',
      appSecret: 'test',
      logger: silentLogger as never,
    }) as unknown as {
      sender: { client: unknown };
      createCard(card: object): Promise<{ cardId: string }>;
    };
    channel.sender.client = {
      cardkit: {
        v1: {
          card: {
            async create() {
              return { code: 200610, msg: 'body is nil' };
            },
          },
        },
      },
    };

    let caught: unknown;
    try {
      await channel.createCard({ schema: '2.0', body: { elements: [] } });
    } catch (err) {
      caught = err;
    }
    expect(readCardApiError(caught)).toEqual({ code: 200610, msg: 'body is nil' });
  });
});
