import { describe, expect, it } from 'vitest';
import {
  OutboundMessageIds,
  OutboundTimeoutError,
  outboundInFlight,
  wrapChannelOutbound,
} from '../../../src/bot/self-message';

describe('wrapChannelOutbound timeout', () => {
  it('rejects a hung send so the caller can drain the chat queue', async () => {
    const channel = {
      send: () => new Promise<never>(() => {}),
      stream: () => new Promise<never>(() => {}),
      updateCard: () => new Promise<never>(() => {}),
    };
    wrapChannelOutbound(channel, new OutboundMessageIds(), { timeoutMs: 20 });

    await expect(channel.send()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(OutboundTimeoutError);
      expect((err as OutboundTimeoutError).op).toBe('send');
      return true;
    });
    await expect(channel.updateCard()).rejects.toBeInstanceOf(OutboundTimeoutError);
  });

  it('still records a send receipt that finishes before the timeout', async () => {
    const outbound = new OutboundMessageIds();
    const channel = {
      send: async () => ({ messageId: 'om_ok' }),
      stream: async () => ({ messageId: 'om_stream' }),
    };
    wrapChannelOutbound(channel, outbound, { timeoutMs: 200 });

    await expect(channel.send()).resolves.toEqual({ messageId: 'om_ok' });
    expect(outbound.has('om_ok')).toBe(true);
  });

  it('keeps a timed-out send in-flight until the underlying request settles', async () => {
    let resolveSend: ((value: { messageId: string }) => void) | undefined;
    const settled: Array<{ uuid: string; messageId?: string }> = [];
    const channel = {
      send: (_chat: string, _content: unknown, _opts?: { uuid?: string }) =>
        new Promise<{ messageId: string }>((resolve) => {
          resolveSend = resolve;
        }),
    };
    wrapChannelOutbound(channel, new OutboundMessageIds(), {
      timeoutMs: 15,
      onSettled: (uuid, result) => {
        settled.push({ uuid, messageId: (result as { messageId?: string }).messageId });
      },
    });

    const pending = channel.send('oc', { markdown: 'hi' }, { uuid: 'notice-1' });
    await expect(pending).rejects.toBeInstanceOf(OutboundTimeoutError);
    expect(outboundInFlight('notice-1')).toBe(true);
    resolveSend?.({ messageId: 'om_late' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outboundInFlight('notice-1')).toBe(false);
    expect(settled).toEqual([{ uuid: 'notice-1', messageId: 'om_late' }]);
  });

  it('does not emit unhandledRejection when a uuid-tagged send fails', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const channel = {
        send: async (_chat: string, _content: unknown, _opts?: { uuid?: string }) => {
          throw new Error('econnreset');
        },
      };
      wrapChannelOutbound(channel, new OutboundMessageIds(), { timeoutMs: 200 });
      await expect(channel.send('oc', { markdown: 'hi' }, { uuid: 'd1' })).rejects.toThrow('econnreset');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('strips the in-process delivery uuid before calling the SDK send', async () => {
    let seen: unknown;
    const channel = {
      send: async (_chat: string, _content: unknown, opts?: unknown) => {
        seen = opts;
        return { messageId: 'om_ok' };
      },
    };
    wrapChannelOutbound(channel, new OutboundMessageIds(), { timeoutMs: 200 });
    await channel.send('oc', { markdown: 'hi' }, { replyTo: 'om_src', uuid: 'delivery-1' });
    expect(seen).toEqual({ replyTo: 'om_src' });
    expect(seen).not.toHaveProperty('uuid');
  });
});
