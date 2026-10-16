import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarkChannelError } from '@larksuite/channel';
import { classify, isGoneMessage } from '../../../src/bot/feishu-error';
import { OutboundTimeoutError } from '../../../src/bot/self-message';
import {
  axiosErrno,
  axiosHttpError,
  axiosLike,
  captureSdkSendError,
  sdkShapedSendError,
} from '../../helpers/sdk-feishu-errors';

afterEach(() => {
  vi.useRealTimers();
});

describe('classify Feishu errors from the real SDK', () => {
  it.each([
    {
      name: '400 format_error',
      cause: axiosHttpError(400, 'invalid content'),
      expected: 'rejected',
    },
    {
      name: '403 permission_denied',
      cause: axiosHttpError(403, 'Bot is not in the chat'),
      expected: 'rejected',
    },
    {
      name: '429 rate_limited',
      cause: axiosHttpError(429, 'Request failed with status code 429'),
      expected: 'link',
    },
    {
      name: '502 wrapped',
      cause: axiosHttpError(502, 'Request failed with status code 502'),
      expected: 'link',
    },
    {
      name: '408',
      cause: axiosHttpError(408, 'Request failed with status code 408'),
      expected: 'link',
    },
    {
      name: 'ENETUNREACH',
      cause: axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'),
      expected: 'link',
    },
    {
      name: 'EHOSTUNREACH',
      cause: axiosErrno('EHOSTUNREACH', 'connect EHOSTUNREACH 1.2.3.4:443'),
      expected: 'link',
    },
    {
      name: 'TLS disconnect',
      cause: axiosErrno(
        'ECONNRESET',
        'Client network socket disconnected before secure TLS connection was established',
      ),
      expected: 'link',
    },
    {
      name: 'timeout ECONNABORTED',
      cause: axiosErrno('ECONNABORTED', 'timeout of 30000ms exceeded'),
      expected: 'link',
    },
  ] as const)('$name maps to $expected', async ({ cause, expected }) => {
    const err = await captureSdkSendError(cause);
    expect(err).toBeInstanceOf(LarkChannelError);
    expect(classify(err)).toBe(expected);
  });

  it('maps OutboundTimeoutError to link', () => {
    expect(classify(new OutboundTimeoutError('send', 30_000))).toBe('link');
  });

  it('maps a raw axios 502 (patchCard path) to link', () => {
    expect(classify(axiosHttpError(502))).toBe('link');
  });

  it('maps a raw axios ENETUNREACH (patchCard path) to link', () => {
    expect(classify(axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'))).toBe('link');
  });

  it('maps a plain bug to local', () => {
    expect(classify(new TypeError('x is not a function'))).toBe('local');
  });

  it('maps stream controller closed to local', () => {
    expect(classify(new Error('stream controller is closed'))).toBe('local');
  });

  it('does not classify by matching error message text', () => {
    expect(classify(new Error('getaddrinfo EAI_AGAIN open.feishu.cn'))).toBe('local');
  });

  it('maps LarkChannelError send_timeout and ssrf_blocked from their codes', () => {
    expect(classify(new LarkChannelError('send_timeout', 'outbound timed out'))).toBe('link');
    expect(classify(new LarkChannelError('ssrf_blocked', 'ssrf_blocked: http://169.254.169.254'))).toBe(
      'rejected',
    );
    expect(classify(new LarkChannelError('format_error', 'bad card'))).toBe('rejected');
    expect(classify(new LarkChannelError('target_revoked', 'message withdrawn'))).toBe('rejected');
    expect(classify(new LarkChannelError('permission_denied', 'no access'))).toBe('rejected');
  });

  it('walks .cause so a wrapper around an SDK error still classifies', async () => {
    const inner = await captureSdkSendError(axiosHttpError(403, 'Bot is not in the chat'));
    expect(classify(Object.assign(new Error('delivery failed'), { cause: inner }))).toBe('rejected');
  });
});

describe('isGoneMessage', () => {
  it.each([230002, 230025, 230026])('treats Feishu %s as a gone card, still classified rejected', (code) => {
    const err = sdkShapedSendError('unknown', axiosLike('message not found', {
      response: { status: 400, data: { code } },
    }));
    expect(classify(err)).toBe('rejected');
    expect(isGoneMessage(err)).toBe(true);
  });

  it('treats HTTP 404 as gone', () => {
    const err = sdkShapedSendError('unknown', axiosHttpError(404));
    expect(classify(err)).toBe('rejected');
    expect(isGoneMessage(err)).toBe(true);
  });

  it('does not treat a generic 400 as gone', () => {
    const err = sdkShapedSendError('unknown', axiosHttpError(400));
    expect(classify(err)).toBe('rejected');
    expect(isGoneMessage(err)).toBe(false);
  });
});
