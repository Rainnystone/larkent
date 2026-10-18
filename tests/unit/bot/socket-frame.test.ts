import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLarkChannel, type LarkChannel } from '@larksuite/channel';
import { startFeishuLink, type Outage } from '../../../src/bot/feishu-link';

const require = createRequire(import.meta.url);

type FakeWsClient = {
  communicate(): void;
  wsConfig: { getWSInstance(): EventEmitter | undefined };
};

type FrameChannel = Omit<LarkChannel, 'rawWsClient'> & {
  watchInboundFrames(client: FakeWsClient): void;
  rawWsClient?: FakeWsClient;
};

const channelFactories = {
  esm: createLarkChannel,
  cjs: require('@larksuite/channel').createLarkChannel as typeof createLarkChannel,
};

/**
 * The patched SDK reports an inbound frame only for the socket `communicate`
 * most recently opened. A frame buffered on the previous socket must not
 * finish a wake reconnect.
 */
describe('inbound frame socket', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['esm', 'cjs'] as const)('does not recover from a frame on a superseded socket (%s)', async (format) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let now = 1_700_000_000_000;
    const recovered: Outage[] = [];
    let current: EventEmitter | undefined;
    const wsClient = {
      communicate() {},
      wsConfig: {
        getWSInstance: () => current,
      },
    };
    let link!: ReturnType<typeof startFeishuLink>;
    const sdk = channelFactories[format]({
      appId: 'cli_test',
      appSecret: 'secret',
      keepalive: {
        onSocketFrame: () => {
          link.noteSocketFrame(now);
        },
      },
    }) as unknown as FrameChannel;
    link = startFeishuLink({
      channel: {
        getConnectionStatus: () => ({ state: 'connected' as const, reconnectAttempts: 0 }),
      } as unknown as LarkChannel,
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: {
        note() {},
        async detect() {
          return { suspended: false };
        },
      },
      reconnect: () => {},
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    now += 5 * 60_000;
    link.noteKeepaliveWake(now);
    expect(link.isDown()).toBe(true);

    sdk.watchInboundFrames(wsClient);
    sdk.rawWsClient = wsClient;

    const stale = new EventEmitter();
    current = stale;
    wsClient.communicate();

    const fresh = new EventEmitter();
    current = fresh;
    wsClient.communicate();

    stale.emit('message', Buffer.from('buffered'));
    expect(recovered).toHaveLength(0);
    expect(link.isDown()).toBe(true);

    fresh.emit('message', Buffer.from('live'));
    expect(recovered).toHaveLength(1);
    expect(link.isDown()).toBe(false);
  });
});

function memoryWatermark(initial?: number): { get(): number | undefined; set(at: number): void } {
  let value = initial;
  return {
    get: () => value,
    set: (at) => {
      value = at;
    },
  };
}
