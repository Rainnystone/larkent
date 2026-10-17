import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OutboundMessageIds,
  OutboundTimeoutError,
  wrapChannelOutbound,
} from '../../../src/bot/self-message';

afterEach(() => {
  vi.useRealTimers();
});

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

  it('reports timeout as a failed outcome without leaving a UUID in-flight map', async () => {
    const outcomes: Array<{ ok: boolean }> = [];
    const channel = {
      send: (..._args: unknown[]) => new Promise<never>(() => {}),
    };
    wrapChannelOutbound(channel, new OutboundMessageIds(), {
      timeoutMs: 15,
      onResult: (result) => {
        outcomes.push({ ok: result.ok });
      },
    });

    await expect(channel.send('oc', { markdown: 'hi' })).rejects.toBeInstanceOf(OutboundTimeoutError);
    expect(outcomes).toEqual([{ ok: false }]);
  });

  it('records a stream messageId at create so the live echo is not a CLI self-send', async () => {
    const outbound = new OutboundMessageIds();
    let duringProducer = false;
    const channel = {
      stream: async (
        _chatId: string,
        input: {
          card?: {
            initial: object;
            producer: (ctrl: { messageId: string; update: (card: unknown) => Promise<void> }) => Promise<void>;
          };
        },
      ) => {
        const ctrl = {
          messageId: 'om_live_stream',
          update: async () => {},
        };
        await input.card?.producer(ctrl);
        return { messageId: 'om_live_stream' };
      },
    };
    wrapChannelOutbound(channel, outbound, { timeoutMs: 200 });

    const pending = channel.stream('oc', {
      card: {
        initial: {},
        producer: async (ctrl) => {
          duringProducer = outbound.has(ctrl.messageId);
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(duringProducer).toBe(true);
    await expect(pending).resolves.toEqual({ messageId: 'om_live_stream' });
    expect(outbound.has('om_live_stream')).toBe(true);
  });

  it('records a markdown stream messageId at create so the live echo is not a CLI self-send', async () => {
    const outbound = new OutboundMessageIds();
    let duringProducer = false;
    const channel = {
      stream: async (
        _chatId: string,
        input: {
          markdown?: (ctrl: { messageId: string; setContent: (text: string) => Promise<void> }) => Promise<void>;
        },
      ) => {
        const ctrl = {
          messageId: 'om_live_md',
          setContent: async () => {},
        };
        await input.markdown?.(ctrl);
        return { messageId: 'om_live_md' };
      },
    };
    wrapChannelOutbound(channel, outbound, { timeoutMs: 200 });

    const pending = channel.stream('oc', {
      markdown: async (ctrl) => {
        duringProducer = outbound.has(ctrl.messageId);
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(duringProducer).toBe(true);
    await expect(pending).resolves.toEqual({ messageId: 'om_live_md' });
    expect(outbound.has('om_live_md')).toBe(true);
  });

  it('does not time out a producer that lasts longer than the outbound request budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const channel = {
      stream: async (
        _chatId: string,
        input: {
          markdown?: (ctrl: { messageId: string; setContent: (text: string) => Promise<void> }) => Promise<void>;
        },
      ) => {
        const ctrl = { messageId: 'om_long', setContent: async () => {} };
        await input.markdown?.(ctrl);
        return { messageId: 'om_long' };
      },
    };
    wrapChannelOutbound(channel, new OutboundMessageIds(), { timeoutMs: 30_000 });

    const pending = channel.stream('oc', {
      markdown: async (ctrl) => {
        await ctrl.setContent('partial');
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5 * 60_000);
        });
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    let settled = false;
    void pending.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 30_000);
    await expect(pending).resolves.toEqual({ messageId: 'om_long' });
  });

  it('rejects a stream whose open never calls the producer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const channel = {
      stream: () => new Promise<never>(() => {}),
    };
    wrapChannelOutbound(channel, new OutboundMessageIds(), { timeoutMs: 40 });
    const pending = channel.stream();
    await vi.advanceTimersByTimeAsync(39);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(OutboundTimeoutError);
      expect((err as OutboundTimeoutError).op).toBe('stream.open');
      return true;
    });
  });

  it('rejects a stream whose close never settles after the producer returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const channel = {
      stream: async (
        _chatId: string,
        input: {
          markdown?: (ctrl: { messageId: string; setContent: (text: string) => Promise<void> }) => Promise<void>;
        },
      ) => {
        await input.markdown?.({ messageId: 'om_hang', setContent: async () => {} });
        await new Promise<never>(() => {});
        return { messageId: 'om_hang' };
      },
    };
    wrapChannelOutbound(channel, new OutboundMessageIds(), { timeoutMs: 40 });
    const pending = channel.stream('oc', {
      markdown: async () => {},
    });
    await vi.advanceTimersByTimeAsync(39);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(OutboundTimeoutError);
      expect((err as OutboundTimeoutError).op).toBe('stream.close');
      return true;
    });
  });

  it('rejects a hung getChatMode whose TCP connect never completes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const channel = {
      getChatMode: () => new Promise<never>(() => {}),
    };
    wrapChannelOutbound(channel, new OutboundMessageIds(), { timeoutMs: 30_000 });

    const pending = channel.getChatMode();
    await vi.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(OutboundTimeoutError);
      expect((err as OutboundTimeoutError).op).toBe('getChatMode');
      return true;
    });
  });

  it('does not emit unhandledRejection when a send fails', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const channel = {
        send: async (..._args: unknown[]) => {
          throw new Error('econnreset');
        },
      };
      wrapChannelOutbound(channel, new OutboundMessageIds(), { timeoutMs: 200 });
      await expect(channel.send('oc', { markdown: 'hi' })).rejects.toThrow('econnreset');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
