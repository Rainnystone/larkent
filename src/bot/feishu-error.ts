import { LarkChannelError } from '@larksuite/channel';
import { OutboundTimeoutError } from './self-message';

export type FeishuErrorClass = 'link' | 'rejected' | 'local';

/** Feishu IM codes that mean the target message is gone and cannot be patched. */
export const FEISHU_GONE_MESSAGE_CODES = new Set([
  230002, // invalid message id
  230025, // message not found
  230026, // message recalled
]);

/** Send/reply/patch codes that mean this bot is not in the chat (or the chat is gone). */
export const FEISHU_NOT_IN_CHAT_CODES = new Set([
  230002, // The bot can not be outside the group
  232009, // chat which has already been dissolved
]);

/** Frequency-limit / permission-budget codes the SDK maps before HTTP status. */
export const FEISHU_TRANSIENT_API_CODES = new Set([
  230020,
  99991400,
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
  if (chain.some((node) => isTransientFeishuCode(node))) return 'link';
  for (const node of chain) {
    if (node instanceof LarkChannelError && node.code === 'rate_limited') return 'link';
  }
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
      case 'rate_limited':
        return 'link';
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
 * Delay until Feishu's `x-ogw-ratelimit-reset` window opens.
 * The header is remaining seconds, a unix timestamp, or an epoch in ms.
 */
export function rateLimitResetDelayMs(err: unknown, now = Date.now()): number | undefined {
  for (const node of causeChain(err)) {
    const raw = headerValue(node, 'x-ogw-ratelimit-reset');
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) continue;
    if (n > 1e11) return Math.max(0, n - now);
    if (n > 1e9) return Math.max(0, n * 1000 - now);
    return n * 1000;
  }
  return undefined;
}

function isTransientFeishuCode(error: unknown): boolean {
  const code = feishuCode(error);
  return code !== undefined && FEISHU_TRANSIENT_API_CODES.has(code);
}

function headerValue(error: unknown, name: string): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const rec = error as { response?: { headers?: unknown }; headers?: unknown };
  return readHeader(rec.response?.headers, name) ?? readHeader(rec.headers, name);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const rec = headers as Record<string, unknown>;
  const direct = rec[name] ?? rec[name.toLowerCase()];
  if (typeof direct === 'string' && direct) return direct;
  if (typeof direct === 'number' && Number.isFinite(direct)) return String(direct);
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const value = get.call(headers, name);
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
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

/**
 * A rejected 4xx that means the bot is outside the group or the chat was
 * dissolved. Distinct from {@link isGoneMessage}: 230002 is also listed as a
 * gone-card code for stream recovery, but automations must treat it as leave.
 */
export function isNotInChat(err: unknown): boolean {
  for (const node of causeChain(err)) {
    const code = feishuCode(node);
    if (code !== undefined && FEISHU_NOT_IN_CHAT_CODES.has(code)) return true;
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
