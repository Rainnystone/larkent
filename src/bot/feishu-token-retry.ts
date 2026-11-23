import type { LarkChannel } from '@larksuite/channel';
import { Readable } from 'node:stream';
import { log } from '../core/logger';

/** Forced refresh cooldown after a failed self-heal (D6). Monotonic clock. */
export const FEISHU_TOKEN_RETRY_COOLDOWN_MS = 10_000;
/** D11: streamed HTTP 4xx error-body read is bounded to 2s. */
export const FEISHU_STREAM_ERROR_BODY_TIMEOUT_MS = 2_000;

const TOKEN_INVALID_CODES = new Set([99991663, 99991661]);
/** D11: read at most 64 KB of a streamed HTTP 4xx error body. */
const STREAM_ERROR_BODY_MAX_BYTES = 64 * 1024;
/** DefaultCache `getCacheKey(CTenantAccessToken, appId)` — `Symbol('tenant-access-token').toString()`. */
const TENANT_TOKEN_CACHE_LEAF = 'Symbol(tenant-access-token)';

const installed = new WeakSet<object>();

interface HttpLike {
  request: (opts: Record<string, unknown>) => Promise<unknown>;
  get: (...args: unknown[]) => Promise<unknown>;
  delete: (...args: unknown[]) => Promise<unknown>;
  head: (...args: unknown[]) => Promise<unknown>;
  options: (...args: unknown[]) => Promise<unknown>;
  post: (url: string, data?: unknown, config?: unknown) => Promise<unknown>;
  put: (...args: unknown[]) => Promise<unknown>;
  patch: (...args: unknown[]) => Promise<unknown>;
}

interface FeishuSdkClient {
  appId: string;
  cache: unknown;
  httpInstance: HttpLike;
  tokenManager: {
    httpInstance?: HttpLike;
    getTenantAccessToken: (params?: unknown) => Promise<string | undefined>;
  };
}

type SendResult =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown; resolved?: unknown };

/**
 * Per-channel tenant-token self-heal (ticket 01).
 *
 * Generated node-sdk methods call `formatPayload` then `this.httpInstance.request`,
 * not `Client.request`. Hook the client's own `httpInstance` (D3).
 */
export function installFeishuTokenRetry(
  channel: Pick<LarkChannel, 'rawClient'>,
  opts?: { now?: () => number },
): void {
  const client = channel.rawClient as unknown;
  if (!isSdkClient(client)) return;
  if (installed.has(client)) return;
  installed.add(client);
  wrapClient(client, opts?.now ?? (() => performance.now()));
}

export function tenantAccessTokenCacheKey(appId: string): string {
  return `${appId}/${TENANT_TOKEN_CACHE_LEAF}`;
}

function wrapClient(client: FeishuSdkClient, now: () => number): void {
  const inner = client.httpInstance;
  const innerRequest = inner.request.bind(inner) as HttpLike['request'];
  const innerPost = inner.post.bind(inner) as HttpLike['post'];
  const knownTenantTokens = new Set<string>();
  let generation = 0;
  let inFlight: Promise<void> | undefined;
  let cooldownUntil = 0;
  let lastRefreshError: unknown;

  const proxy: HttpLike = {
    request: (opts) => wrappedRequest(opts),
    post: (url, data, config) => wrappedPost(url, data, config),
    get: bindMethod(inner, 'get'),
    delete: bindMethod(inner, 'delete'),
    head: bindMethod(inner, 'head'),
    options: bindMethod(inner, 'options'),
    put: bindMethod(inner, 'put'),
    patch: bindMethod(inner, 'patch'),
  };
  client.httpInstance = proxy;
  client.tokenManager.httpInstance = proxy;

  async function wrappedPost(url: string, data?: unknown, config?: unknown): Promise<unknown> {
    if (isTenantTokenUrl(url) && now() < cooldownUntil) {
      throw lastRefreshError ?? new Error('tenant token refresh cooling down');
    }
    return innerPost(url, data, config);
  }

  async function wrappedRequest(opts: Record<string, unknown>): Promise<unknown> {
    const sendGen = generation;
    const signal = requestSignal(opts);
    noteCachedToken();
    const first = await send(innerRequest, opts);
    if (first.ok) return first.value;
    if (!shouldSelfHeal(opts, first, knownTenantTokens)) return failOut(first);
    if (now() < cooldownUntil) return failOut(first);
    if (isAborted(signal)) return failOut(first);
    try {
      await refreshFrom(sendGen);
    } catch {
      log.warn('auth', 'token-refresh-failed', {
        appId: client.appId,
        code: feishuCode(first.error) ?? feishuCode(first.resolved),
        outcome: 'refresh-failed',
      });
      return failOut(first);
    }
    if (isAborted(signal)) return failOut(first);
    const token = await replayToken();
    if (isAborted(signal)) return failOut(first);
    const replay = await send(innerRequest, withAuthorization(opts, token));
    if (replay.ok) {
      log.info('auth', 'token-refreshed', {
        appId: client.appId,
        code: feishuCode(first.error) ?? feishuCode(first.resolved),
        outcome: 'replayed',
      });
      return replay.value;
    }
    if (isTokenInvalidResult(replay)) {
      lastRefreshError = first.error;
      cooldownUntil = now() + FEISHU_TOKEN_RETRY_COOLDOWN_MS;
      log.warn('auth', 'token-refresh-failed', {
        appId: client.appId,
        code: feishuCode(replay.error) ?? feishuCode(replay.resolved) ?? feishuCode(first.error),
        outcome: 'replay-failed',
      });
      return failOut(first);
    }
    return failOut(replay);
  }

  function noteCachedToken(): string | undefined {
    const cached = peekTenantToken(client.cache, client.appId);
    if (cached) knownTenantTokens.add(cached);
    return cached;
  }

  async function replayToken(): Promise<string> {
    const cached = noteCachedToken();
    if (cached) return cached;
    const token = await client.tokenManager.getTenantAccessToken();
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('tenant token missing after refresh');
    }
    knownTenantTokens.add(token);
    return token;
  }

  async function refreshFrom(sendGen: number): Promise<void> {
    if (sendGen !== generation) return;
    if (now() < cooldownUntil) {
      throw lastRefreshError ?? new Error('tenant token refresh cooling down');
    }
    if (!inFlight) {
      inFlight = (async () => {
        if (sendGen !== generation) return;
        evictTenantToken(client.cache, client.appId);
        const token = await client.tokenManager.getTenantAccessToken();
        if (typeof token !== 'string' || token.length === 0) {
          throw new Error('tenant token refresh returned empty');
        }
        knownTenantTokens.add(token);
        generation += 1;
      })().catch((err: unknown) => {
        lastRefreshError = err;
        cooldownUntil = now() + FEISHU_TOKEN_RETRY_COOLDOWN_MS;
        throw err;
      }).finally(() => {
        inFlight = undefined;
      });
    }
    await inFlight;
  }
}

async function send(
  request: HttpLike['request'],
  opts: Record<string, unknown>,
): Promise<SendResult> {
  try {
    const value = await request(opts);
    if (opts.responseType !== 'stream' && isTokenInvalid(value)) {
      return { ok: false, error: value, resolved: value };
    }
    return { ok: true, value };
  } catch (error) {
    if (opts.responseType === 'stream' && isHttp4xx(error)) {
      await hydrateStreamTokenError(error);
    }
    if (!isTokenInvalid(error)) throw error;
    return { ok: false, error };
  }
}

function isHttp4xx(error: unknown): boolean {
  const status = httpStatus(error);
  return status !== undefined && status >= 400 && status < 500;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const rec = error as { response?: { status?: unknown }; status?: unknown };
  const nested = rec.response?.status;
  if (typeof nested === 'number') return nested;
  return typeof rec.status === 'number' ? rec.status : undefined;
}

function errorResponse(error: unknown): { data?: unknown } | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return undefined;
  return response as { data?: unknown };
}

type StreamErrorBodyRead =
  | { status: 'complete'; buf: Buffer }
  | { status: 'overflow'; buf: Buffer }
  | { status: 'timeout'; buf: Buffer; restored: boolean };

/**
 * On a streamed HTTP 4xx, read a bounded JSON error body and apply D2.
 * Oversize, non-JSON, a read failure, or a 2s stall rethrow the original
 * error with the body still readable. Never called for 2xx streams.
 */
async function hydrateStreamTokenError(error: unknown): Promise<void> {
  if (isTokenInvalid(error)) return;
  const response = errorResponse(error);
  if (!response) return;
  const data = response.data;
  if (
    data !== null
    && typeof data === 'object'
    && !Buffer.isBuffer(data)
    && !(data instanceof Uint8Array)
    && !(data instanceof Readable)
  ) {
    return;
  }
  const raw = await readErrorBody(data);
  if (raw === undefined) return;
  switch (raw.status) {
    case 'timeout':
      if (!raw.restored) response.data = readablePrefixThenRest(raw.buf, data);
      return;
    case 'overflow':
      if (data instanceof Readable) {
        response.data = readableFrom(raw.buf);
        data.destroy();
      }
      return;
    case 'complete':
      try {
        const parsed: unknown = JSON.parse(raw.buf.toString('utf8'));
        if (isTokenInvalid(parsed) || isTokenInvalid({ response: { data: parsed } })) {
          response.data = parsed;
          return;
        }
      } catch {
        /* non-JSON */
      }
      if (data instanceof Readable) response.data = readableFrom(raw.buf);
      return;
    default: {
      const _never: never = raw;
      return _never;
    }
  }
}

function readableFrom(buf: Buffer): Readable {
  return Readable.from([buf]);
}

function readablePrefixThenRest(prefix: Buffer, data: unknown): unknown {
  if (!(data instanceof Readable)) return prefix.length > 0 ? readableFrom(prefix) : data;
  if (prefix.length === 0) return data;
  if (!data.readable) return readableFrom(prefix);
  return Readable.from(yieldPrefixThenRest(prefix, data));
}

async function* yieldPrefixThenRest(prefix: Buffer, rest: Readable): AsyncGenerator<Buffer> {
  yield prefix;
  for await (const chunk of rest) {
    yield toBuffer(chunk);
  }
}

async function readErrorBody(data: unknown): Promise<StreamErrorBodyRead | undefined> {
  if (typeof data === 'string') return boundedBuffer(Buffer.from(data));
  if (Buffer.isBuffer(data)) return boundedBuffer(data);
  if (data instanceof Uint8Array) return boundedBuffer(Buffer.from(data));
  if (!(data instanceof Readable)) return undefined;
  return readReadableBounded(data, STREAM_ERROR_BODY_MAX_BYTES, FEISHU_STREAM_ERROR_BODY_TIMEOUT_MS);
}

function boundedBuffer(buf: Buffer): StreamErrorBodyRead {
  return buf.length > STREAM_ERROR_BODY_MAX_BYTES
    ? { status: 'overflow', buf }
    : { status: 'complete', buf };
}

async function readReadableBounded(
  stream: Readable,
  max: number,
  timeoutMs: number,
): Promise<StreamErrorBodyRead | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let settled = false;

    const stopListening = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      if (stream.readable) stream.pause();
    };

    const finish = (result: StreamErrorBodyRead | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopListening();
      resolve(result);
    };

    const onData = (chunk: unknown): void => {
      if (settled) return;
      const buf = toBuffer(chunk);
      chunks.push(buf);
      n += buf.length;
      if (n > max) finish({ status: 'overflow', buf: Buffer.concat(chunks) });
    };
    const onEnd = (): void => {
      if (settled) return;
      finish({ status: 'complete', buf: Buffer.concat(chunks) });
    };
    const onError = (): void => {
      if (settled) return;
      if (n > 0) finish({ status: 'complete', buf: Buffer.concat(chunks) });
      else finish(undefined);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      stopListening();
      const buf = Buffer.concat(chunks);
      finish({ status: 'timeout', buf, restored: restoreUnread(stream, buf) });
    }, timeoutMs);

    stream.on('error', onError);
    stream.on('end', onEnd);
    stream.on('data', onData);
  });
}

function restoreUnread(stream: Readable, prefix: Buffer): boolean {
  if (prefix.length === 0) return stream.readable;
  if (!stream.readable) return false;
  try {
    stream.unshift(prefix);
    return true;
  } catch {
    return false;
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

function shouldSelfHeal(
  opts: Record<string, unknown>,
  first: SendResult & { ok: false },
  knownTenantTokens: Set<string>,
): boolean {
  const url = typeof opts.url === 'string' ? opts.url : undefined;
  if (!isOpenApiUrl(url)) return false;
  if (!isTokenInvalidResult(first)) return false;
  return usesTenantCredential(opts.headers, knownTenantTokens);
}

function usesTenantCredential(headers: unknown, knownTenantTokens: Set<string>): boolean {
  const auth = headerAuthorization(headers);
  if (!auth) return true;
  return knownTenantTokens.has(stripBearer(auth));
}

function failOut(first: SendResult & { ok: false }): never {
  if (first.resolved !== undefined) {
    throw Object.assign(new Error(`Feishu API code ${feishuCode(first.resolved) ?? '?'}`), {
      response: { data: first.resolved },
    });
  }
  throw first.error;
}

function isTokenInvalidResult(result: SendResult): boolean {
  if (result.ok) return false;
  return isTokenInvalid(result.error) || isTokenInvalid(result.resolved);
}

function isTokenInvalid(value: unknown): boolean {
  const code = feishuCode(value);
  return code !== undefined && TOKEN_INVALID_CODES.has(code);
}

function feishuCode(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as {
    code?: unknown;
    response?: { data?: { code?: unknown } };
    data?: { code?: unknown };
  };
  if (typeof rec.code === 'number') return rec.code;
  const nested = rec.response?.data?.code;
  if (typeof nested === 'number') return nested;
  const wrapped = rec.data?.code;
  return typeof wrapped === 'number' ? wrapped : undefined;
}

function requestSignal(opts: Record<string, unknown>): AbortSignal | undefined {
  return opts.signal instanceof AbortSignal ? opts.signal : undefined;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isOpenApiUrl(url: string | undefined): boolean {
  return Boolean(url && url.includes('/open-apis/') && !isTenantTokenUrl(url));
}

function isTenantTokenUrl(url: string | undefined): boolean {
  return Boolean(url && url.includes('/open-apis/auth/v3/tenant_access_token'));
}

function headerAuthorization(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const rec = headers as Record<string, unknown> & { get?: (k: string) => unknown };
  const direct = rec.Authorization ?? rec.authorization;
  if (typeof direct === 'string' && direct) return direct;
  if (typeof rec.get === 'function') {
    const value = rec.get('Authorization') ?? rec.get('authorization');
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function stripBearer(authorization: string): string {
  return authorization.replace(/^Bearer\s+/i, '');
}

function withAuthorization(opts: Record<string, unknown>, token: string): Record<string, unknown> {
  return {
    ...opts,
    headers: {
      ...cloneHeaders(opts.headers),
      Authorization: `Bearer ${token}`,
    },
  };
}

function cloneHeaders(headers: unknown): Record<string, unknown> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[key] = value;
  }
  return out;
}

function peekTenantToken(cache: unknown, appId: string): string | undefined {
  const values = cacheMap(cache);
  if (!values) return undefined;
  const entry = values.get(tenantAccessTokenCacheKey(appId));
  if (!entry) return undefined;
  if (!entry.expiredTime || entry.expiredTime - Date.now() > 0) {
    return typeof entry.value === 'string' ? entry.value : undefined;
  }
  return undefined;
}

function evictTenantToken(cache: unknown, appId: string): void {
  const values = cacheMap(cache);
  if (!values) return;
  values.delete(tenantAccessTokenCacheKey(appId));
}

function cacheMap(
  cache: unknown,
): Map<unknown, { value?: unknown; expiredTime?: number }> | undefined {
  if (!cache || typeof cache !== 'object') return undefined;
  const values = (cache as { values?: unknown }).values;
  if (!(values instanceof Map)) return undefined;
  return values as Map<unknown, { value?: unknown; expiredTime?: number }>;
}

function isSdkClient(client: unknown): client is FeishuSdkClient {
  if (!client || typeof client !== 'object') return false;
  const rec = client as FeishuSdkClient;
  return typeof rec.appId === 'string'
    && Boolean(rec.httpInstance)
    && typeof rec.httpInstance.request === 'function'
    && Boolean(rec.tokenManager)
    && typeof rec.tokenManager.getTenantAccessToken === 'function';
}

function bindMethod(inner: HttpLike, key: Exclude<keyof HttpLike, 'request' | 'post'>): HttpLike[typeof key] {
  const fn = inner[key];
  if (typeof fn === 'function') return fn.bind(inner);
  return async () => {
    throw new Error(`httpInstance.${key} is not a function`);
  };
}
