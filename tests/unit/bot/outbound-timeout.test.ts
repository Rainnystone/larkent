import { describe, expect, it } from 'vitest';
import {
  OutboundMessageIds,
  OutboundTimeoutError,
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
});
