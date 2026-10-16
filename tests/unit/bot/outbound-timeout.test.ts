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
});
