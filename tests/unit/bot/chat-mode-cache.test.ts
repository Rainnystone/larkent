import { describe, expect, it } from 'vitest';
import { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { OutboundTimeoutError } from '../../../src/bot/self-message.js';

describe('ChatModeCache', () => {
  it('caches group mode to avoid a chat.get round-trip per message', async () => {
    const cache = new ChatModeCache();
    const channel = new FakeModeChannel(['group', 'topic']);

    await expect(cache.resolve(channel as never, 'oc_chat')).resolves.toBe('group');
    // Second lookup is served from cache — the queued 'topic' is never consumed.
    await expect(cache.resolve(channel as never, 'oc_chat')).resolves.toBe('group');
    expect(channel.calls).toBe(1);
  });

  it('re-probes after invalidate so a topic conversion is detected', async () => {
    const cache = new ChatModeCache();
    const channel = new FakeModeChannel(['group', 'topic']);

    await expect(cache.resolve(channel as never, 'oc_chat')).resolves.toBe('group');
    // The channel layer invalidates when a message carries a threadId but the
    // cached mode is still 'group' (a converted topic group).
    cache.invalidate('oc_chat');
    await expect(cache.resolve(channel as never, 'oc_chat')).resolves.toBe('topic');
    expect(channel.calls).toBe(2);
  });

  it('caches topic mode once resolved', async () => {
    const cache = new ChatModeCache();
    const channel = new FakeModeChannel(['topic', 'group']);

    await expect(cache.resolve(channel as never, 'oc_chat')).resolves.toBe('topic');
    await expect(cache.resolve(channel as never, 'oc_chat')).resolves.toBe('topic');
    expect(channel.calls).toBe(1);
  });

  it('does not swallow a link error so intake can release the claim', async () => {
    const cache = new ChatModeCache();
    const err = new OutboundTimeoutError('getChatMode', 30_000);
    const channel = {
      calls: 0,
      async getChatMode(): Promise<'group' | 'topic'> {
        this.calls += 1;
        throw err;
      },
    };

    await expect(cache.resolve(channel as never, 'oc_chat')).rejects.toBe(err);
    expect(channel.calls).toBe(1);
    await expect(cache.resolve(channel as never, 'oc_chat')).rejects.toBe(err);
  });

  it('still falls back to group on a local lookup error', async () => {
    const cache = new ChatModeCache();
    const channel = {
      async getChatMode(): Promise<'group' | 'topic'> {
        throw new Error('permission denied in test');
      },
    };

    await expect(cache.resolve(channel as never, 'oc_chat')).resolves.toBe('group');
  });
});

class FakeModeChannel {
  calls = 0;
  private readonly modes: Array<'group' | 'topic'>;

  constructor(modes: Array<'group' | 'topic'>) {
    this.modes = [...modes];
  }

  async getChatMode(): Promise<'group' | 'topic'> {
    this.calls++;
    return this.modes.shift() ?? 'group';
  }
}
