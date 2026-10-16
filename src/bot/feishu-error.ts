import { LarkChannelError } from '@larksuite/channel';
import { OutboundTimeoutError } from './self-message';

export type FeishuErrorClass = 'link' | 'rejected' | 'local';

/** Feishu IM codes that mean the target message is gone and cannot be patched. */
export const FEISHU_GONE_MESSAGE_CODES = new Set([
  230002, // invalid message id
  230025, // message not found
  230026, // message recalled
]);

const NETWORK_ERRNO = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Sort a Feishu / outbound error into one closed class.
 * Walks `err → .cause → .cause`, then applies the rules in order.
 * Never matches message text.
 */
export function classify(err: unknown): FeishuErrorClass {
  const chain = [...causeChain(err)];
  if (chain.some((node) => node instanceof OutboundTimeoutError)) return 'link';
  for (const node of chain) {
    const status = httpStatus(node);
    if (status !== undefined && (status >= 500 || status === 408 || status === 429)) {
      return 'link';
    }
  }
  for (const node of chain) {
    const status = httpStatus(node);
    if (status !== undefined && status >= 400 && status < 500) return 'rejected';
  }
  for (const node of chain) {
    if (!(node instanceof LarkChannelError)) continue;
    switch (node.code) {
      case 'format_error':
      case 'target_revoked':
      case 'permission_denied':
      case 'ssrf_blocked':
        return 'rejected';
      case 'send_timeout':
        return 'link';
      case 'rate_limited':
      case 'upload_failed':
      case 'not_connected':
      case 'not_supported':
      case 'meeting_not_found':
      case 'too_many_sessions':
      case 'unknown':
        break;
      default: {
        const _exhaustive: never = node.code;
        void _exhaustive;
        break;
      }
    }
  }
  for (const node of chain) {
    if (axiosRequestWithoutResponse(node) || networkErrno(node)) return 'link';
  }
  return 'local';
}

/**
 * A rejected 4xx that means the interactive card is gone, so same-card patch
 * can never succeed. Used by stream recovery to fall back to a uuid-keyed send.
 * Not a fourth classify() class — a refinement of `rejected`.
 */
export function isGoneMessage(err: unknown): boolean {
  for (const node of causeChain(err)) {
    const status = httpStatus(node);
    if (status === 404) return true;
    const code = feishuCode(node);
    if (code !== undefined && FEISHU_GONE_MESSAGE_CODES.has(code)) return true;
  }
  return false;
}

function* causeChain(err: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    if (typeof current !== 'object') return;
    current = (current as { cause?: unknown }).cause;
  }
}

function feishuCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const rec = error as { code?: unknown; response?: { data?: { code?: unknown } } };
  if (typeof rec.code === 'number') return rec.code;
  const nested = rec.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const rec = error as { response?: { status?: unknown }; status?: unknown };
  const nested = rec.response?.status;
  if (typeof nested === 'number') return nested;
  return typeof rec.status === 'number' ? rec.status : undefined;
}

function axiosRequestWithoutResponse(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const rec = error as { isAxiosError?: unknown; request?: unknown; response?: unknown };
  if (rec.isAxiosError !== true) return false;
  if (rec.request === undefined || rec.request === null) return false;
  return rec.response === undefined || rec.response === null;
}

function networkErrno(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && NETWORK_ERRNO.has(code);
}
