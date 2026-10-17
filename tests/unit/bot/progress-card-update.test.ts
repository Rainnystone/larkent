import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLarkChannel } from '@larksuite/channel';

const PATCH_ERR = new Error(
  'failed to get tenant_access_token, code: 10014, msg: app secret invalid',
);

const PROGRESS_CARD = {
  schema: '2.0',
  body: { elements: [{ tag: 'markdown', content: 'tool running' }] },
};

afterEach(() => {
  vi.useRealTimers();
});

describe('progress-card intermediate patch failures', () => {
  it('does not emit unhandledRejection when a timer-driven card patch rejects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const captured = listenUnhandled();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const warns: unknown[][] = [];
    const channel = stubbedCardStream({
      patch: async () => {
        throw PATCH_ERR;
      },
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
    });
    const stream = channel.stream('oc_test', {
      card: {
        initial: PROGRESS_CARD,
        producer: async (ctrl) => {
          await ctrl.update(PROGRESS_CARD);
          await hold;
        },
      },
    });

    try {
      await flushThrottle();
      expect(captured.rejections, String(captured.rejections[0])).toEqual([]);
      expect(warns).toHaveLength(1);
      expect(JSON.stringify(warns[0])).toContain('channel: stream intermediate patch failed');
      expect(JSON.stringify(warns[0])).toContain('"messageId":"1234"');
      expect(JSON.stringify(warns[0])).toContain(PATCH_ERR.message);
      expect(JSON.stringify(warns[0])).not.toContain('om_abcd1234');
    } finally {
      release();
      await stream.catch(() => undefined);
      await flushThrottle();
      captured.stop();
    }
  });

  it('still resolves channel.stream when only an intermediate card patch fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const captured = listenUnhandled();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let patches = 0;
    const channel = stubbedCardStream({
      patch: async () => {
        patches += 1;
        if (patches === 1) throw PATCH_ERR;
        return {};
      },
      warn: () => {},
    });
    const stream = channel.stream('oc_test', {
      card: {
        initial: PROGRESS_CARD,
        producer: async (ctrl) => {
          await ctrl.update(PROGRESS_CARD);
          await hold;
        },
      },
    });

    try {
      await flushThrottle();
      expect(patches).toBeGreaterThanOrEqual(1);
      expect(captured.rejections, String(captured.rejections[0])).toEqual([]);
      release();
      await expect(stream).resolves.toEqual({ messageId: 'om_abcd1234' });
      expect(captured.rejections, String(captured.rejections[0])).toEqual([]);
    } finally {
      release();
      await stream.catch(() => undefined);
      captured.stop();
    }
  });

  it('still rejects channel.stream when the terminal card flush patch fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const captured = listenUnhandled();
    const channel = stubbedCardStream({
      patch: async () => {
        throw PATCH_ERR;
      },
      warn: () => {},
    });
    const stream = channel.stream('oc_test', {
      card: {
        initial: PROGRESS_CARD,
        producer: async (ctrl) => {
          await ctrl.update(PROGRESS_CARD);
        },
      },
    });

    try {
      await expect(stream).rejects.toBe(PATCH_ERR);
      await flushThrottle();
      expect(captured.rejections, String(captured.rejections[0])).toEqual([]);
    } finally {
      captured.stop();
    }
  });

  it('does not emit unhandledRejection when a timer-driven markdown patch rejects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const captured = listenUnhandled();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const warns: unknown[][] = [];
    const channel = stubbedMarkdownStream({
      update: async () => {
        throw PATCH_ERR;
      },
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
    });
    const stream = channel.stream('oc_test', {
      markdown: async (ctrl) => {
        await ctrl.setContent('tool running on the progress card');
        await hold;
      },
    });

    try {
      await flushThrottle();
      expect(captured.rejections, String(captured.rejections[0])).toEqual([]);
      expect(warns.length).toBeGreaterThanOrEqual(1);
    } finally {
      release();
      await stream.catch(() => undefined);
      await flushThrottle();
      captured.stop();
    }
  });
});

function listenUnhandled(): { rejections: unknown[]; stop(): void } {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  return {
    rejections,
    stop() {
      process.off('unhandledRejection', onUnhandled);
    },
  };
}

async function flushThrottle(): Promise<void> {
  for (let n = 0; n < 20; n++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(20);
  for (let n = 0; n < 20; n++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function stubbedCardStream(opts: {
  patch: () => Promise<unknown>;
  warn: (...args: unknown[]) => void;
}): {
  stream: (
    to: string,
    input: {
      card: {
        initial: unknown;
        producer: (ctrl: { update(card: unknown): Promise<void> }) => Promise<void>;
      };
    },
  ) => Promise<{ messageId: string }>;
} {
  const channel = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'test',
    outbound: {
      retry: { maxAttempts: 1 },
      streamThrottleMs: 10,
      streamThrottleChars: 1,
    },
    logger: loggerWith(opts.warn) as never,
  }) as unknown as {
    sender: { client: unknown };
    stream: (
      to: string,
      input: {
        card: {
          initial: unknown;
          producer: (ctrl: { update(card: unknown): Promise<void> }) => Promise<void>;
        };
      },
    ) => Promise<{ messageId: string }>;
  };
  channel.sender.client = {
    im: {
      v1: {
        message: {
          create: async () => ({ data: { message_id: 'om_abcd1234' } }),
          reply: async () => ({ data: { message_id: 'om_abcd1234' } }),
          patch: opts.patch,
        },
      },
    },
  };
  return channel;
}

function stubbedMarkdownStream(opts: {
  update: () => Promise<unknown>;
  warn: (...args: unknown[]) => void;
}): {
  stream: (
    to: string,
    input: { markdown: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void> },
  ) => Promise<{ messageId: string }>;
} {
  const channel = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'test',
    outbound: {
      retry: { maxAttempts: 1 },
      streamThrottleMs: 10,
      streamThrottleChars: 1,
    },
    logger: loggerWith(opts.warn) as never,
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
          content: opts.update,
        },
      },
    },
    im: {
      v1: {
        message: {
          create: async () => ({ data: { message_id: 'om_md1234' } }),
          reply: async () => ({ data: { message_id: 'om_md1234' } }),
          patch: async () => ({}),
        },
      },
    },
  };
  return channel;
}

function loggerWith(warn: (...args: unknown[]) => void) {
  return {
    debug() {},
    info() {},
    warn,
    error() {},
    trace() {},
  };
}
