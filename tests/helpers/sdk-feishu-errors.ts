import { createLarkChannel, LarkChannelError } from '@larksuite/channel';

/**
 * Axios-shaped errors as `@larksuite/channel` 0.7.1 puts them on
 * `LarkChannelError.cause`. Real Axios always has `request`; status lives on
 * `response` when Feishu answered.
 */
export function axiosLike(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { isAxiosError: true, request: {}, ...extra });
}

export function axiosHttpError(status: number, message?: string): Error {
  return axiosLike(message ?? `Request failed with status code ${status}`, {
    response: { status },
  });
}

export function axiosErrno(code: string, message: string): Error {
  return axiosLike(message, { code });
}

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
};

/**
 * Drive a real `channel.send` with `sender.client` stubbed so the SDK wraps
 * the axios-like throw in `LarkChannelError` the same way production does.
 */
export async function captureSdkSendError(cause: Error): Promise<unknown> {
  const channel = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'test',
    outbound: { retry: { maxAttempts: 1 } },
    logger: silentLogger as never,
  }) as unknown as {
    sender: { client: unknown };
    send: (to: string, input: { text: string }) => Promise<unknown>;
  };
  channel.sender.client = {
    im: {
      v1: {
        message: {
          create: async () => {
            throw cause;
          },
          reply: async () => {
            throw cause;
          },
        },
      },
    },
  };
  try {
    await channel.send('oc_test', { text: 'x' });
  } catch (err) {
    return err;
  }
  throw new Error('expected channel.send to reject');
}

export function sdkShapedSendError(code: ConstructorParameters<typeof LarkChannelError>[0], cause: Error): LarkChannelError {
  return new LarkChannelError(code, cause.message, { cause });
}
