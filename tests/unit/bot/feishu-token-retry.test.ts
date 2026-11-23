import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLarkChannel, type LarkChannel } from '@larksuite/channel';
import { log } from '../../../src/core/logger';
import {
  FEISHU_STREAM_ERROR_BODY_TIMEOUT_MS,
  FEISHU_TOKEN_RETRY_COOLDOWN_MS,
  installFeishuTokenRetry,
  tenantAccessTokenCacheKey,
} from '../../../src/bot/feishu-token-retry';

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(
  createRequire(require.resolve('@larksuite/channel')).resolve('@larksuiteoapi/node-sdk'),
);
const {
  DefaultCache,
  CTenantAccessToken,
  withUserAccessToken,
} = sdkRequire('@larksuiteoapi/node-sdk') as {
  DefaultCache: new () => SdkCache;
  CTenantAccessToken: symbol;
  withUserAccessToken: (token: string) => unknown;
};

interface SdkCache {
  get: (key: unknown, options?: { namespace?: string }) => Promise<unknown>;
  set: (
    key: unknown,
    value: unknown,
    expiredTime?: number,
    options?: { namespace?: string },
  ) => Promise<boolean>;
  values: Map<unknown, { value?: unknown; expiredTime?: number }>;
}

const DEAD_TOKEN = 'dead-tenant-tok-aaa';
const FRESH_TOKEN = 'fresh-tenant-tok-bbb';
const USER_TOKEN = 'user-access-tok-ccc';
const APP_A = 'cli_token_retry_a';
const APP_B = 'cli_token_retry_b';
const SILENT = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
};

type ApiScript =
  | { type: 'ok' }
  | { type: 'http'; status: number; code: number }
  | { type: 'resolved'; code: number }
  | { type: 'status'; status: number };

interface RecordedCall {
  kind: 'auth' | 'api';
  method: string;
  url: string;
  authorization?: string;
}

interface FakeHttp {
  authPosts: number;
  apiCalls: RecordedCall[];
  calls: RecordedCall[];
  authOk: boolean;
  /** When false, even a fresh tenant token is rejected (exhausted self-heal). */
  replaySucceeds: boolean;
  /** Override the HTTP 4xx stream body; default is JSON 99991663. */
  streamErrorBody?: Buffer | string | Readable;
  api: ApiScript;
  onAuth?: () => Promise<void> | void;
  beforeApi?: (call: RecordedCall, index: number) => Promise<void> | void;
  request: (opts: Record<string, unknown>) => Promise<unknown>;
  get: (...args: unknown[]) => Promise<unknown>;
  delete: (...args: unknown[]) => Promise<unknown>;
  head: (...args: unknown[]) => Promise<unknown>;
  options: (...args: unknown[]) => Promise<unknown>;
  post: (url: string, body?: unknown) => Promise<unknown>;
  put: (...args: unknown[]) => Promise<unknown>;
  patch: (...args: unknown[]) => Promise<unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Feishu tenant token self-heal (ticket 01)', () => {
  it('cached 400/99991663 self-heals rawClient.request, im.v1.message.create, and getAppInfo with one auth POST and one replay', async () => {
    const h = harness(APP_A);
    await seedDead(h.cache, APP_A);

    const beforeRequest = h.http.authPosts;
    const req = await h.channel.rawClient.request({
      method: 'GET',
      url: '/open-apis/vc/v1/bots/events',
      params: { meeting_id: 'm_1' },
    }) as { code?: number; data?: { ok?: boolean } };
    expect(req.code).toBe(0);
    expect(req.data?.ok).toBe(true);
    expect(h.http.authPosts - beforeRequest).toBe(1);
    expect(apiAuths(h.http)).toEqual([DEAD_TOKEN, FRESH_TOKEN]);

    h.http.apiCalls = [];
    await seedDead(h.cache, APP_A);
    const beforeCreate = h.http.authPosts;
    const created = await h.channel.rawClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat',
        msg_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
        uuid: 'reply:token-01',
      },
    }) as { code?: number; data?: { message_id?: string } };
    expect(created.code).toBe(0);
    expect(created.data?.message_id).toBe('om_ok');
    expect(h.http.authPosts - beforeCreate).toBe(1);
    expect(apiAuths(h.http)).toEqual([DEAD_TOKEN, FRESH_TOKEN]);
    expect(h.http.apiCalls.some((c) => c.url.includes('/im/v1/messages') && c.method.toUpperCase() === 'POST')).toBe(true);

    h.http.apiCalls = [];
    await seedDead(h.cache, APP_A);
    const beforeInfo = h.http.authPosts;
    const info = await h.channel.getAppInfo();
    expect(info.ownerId).toBe('ou_owner');
    expect(info.appName).toBe('retry-bot');
    expect(h.http.authPosts - beforeInfo).toBe(1);
    expect(apiAuths(h.http)).toEqual([DEAD_TOKEN, FRESH_TOKEN]);
    expect(h.http.apiCalls.some((c) => c.url.includes('/application/v6/applications/'))).toBe(true);
  });

  it('self-heals 400/99991661 and resolved 200/99991663', async () => {
    const h = harness(APP_A);

    await seedDead(h.cache, APP_A);
    h.http.api = { type: 'http', status: 400, code: 99991661 };
    h.http.apiCalls = [];
    const missing = await h.channel.rawClient.request({
      method: 'GET',
      url: '/open-apis/vc/v1/bots/events',
    }) as { code?: number };
    expect(missing.code).toBe(0);
    expect(h.http.authPosts).toBe(1);
    expect(apiAuths(h.http)).toEqual([DEAD_TOKEN, FRESH_TOKEN]);

    await seedDead(h.cache, APP_A);
    h.http.api = { type: 'resolved', code: 99991663 };
    h.http.apiCalls = [];
    const info = await h.channel.getAppInfo();
    expect(info.ownerId).toBe('ou_owner');
    expect(h.http.authPosts).toBe(2);
    expect(apiAuths(h.http)).toEqual([DEAD_TOKEN, FRESH_TOKEN]);
  });

  it('eight concurrent plus one late rejection share one auth POST and keep the new token', async () => {
    const h = harness(APP_A);
    await seedDead(h.cache, APP_A);

    const barrier = deferred();
    const refreshed = deferred();
    let arrivals = 0;
    h.http.beforeApi = async (call) => {
      if (bearer(call.authorization) !== DEAD_TOKEN) return;
      arrivals += 1;
      const index = arrivals;
      if (index === 9) barrier.resolve();
      await barrier.promise;
      if (index === 9) await refreshed.promise;
    };
    h.http.onAuth = () => {
      refreshed.resolve();
    };

    const results = await Promise.all(
      Array.from({ length: 9 }, () => createMessage(h.channel)),
    );
    expect(results.every((r) => r.data?.message_id === 'om_ok')).toBe(true);
    expect(h.http.authPosts).toBe(1);
    expect(await h.cache.get(CTenantAccessToken, { namespace: APP_A })).toBe(FRESH_TOKEN);
  });

  it('exhausted refresh replays at most once, cools down 10s, logs token-refresh-failed, and never logs a token', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    let now = 1_000;
    const h = harness(APP_A, { now: () => now });
    await seedDead(h.cache, APP_A);
    h.http.api = { type: 'http', status: 400, code: 99991663 };
    h.http.replaySucceeds = false;

    await expect(createMessage(h.channel)).rejects.toMatchObject({
      response: { data: { code: 99991663 } },
    });
    expect(h.http.authPosts).toBe(1);
    expect(apiAuths(h.http)).toEqual([DEAD_TOKEN, FRESH_TOKEN]);
    expect(warn.mock.calls.some((c) => c[0] === 'auth' && c[1] === 'token-refresh-failed')).toBe(true);
    expect(info.mock.calls.some((c) => c[0] === 'auth' && c[1] === 'token-refreshed')).toBe(false);
    assertNoTokenInLogs(warn, info);

    const postsAfterFirst = h.http.authPosts;
    h.http.apiCalls = [];
    await expect(createMessage(h.channel)).rejects.toBeTruthy();
    expect(h.http.authPosts).toBe(postsAfterFirst);

    now += FEISHU_TOKEN_RETRY_COOLDOWN_MS;
    h.http.apiCalls = [];
    await expect(createMessage(h.channel)).rejects.toBeTruthy();
    expect(h.http.authPosts).toBe(postsAfterFirst + 1);

    let authNow = 50_000;
    const authFail = harness(APP_A, { now: () => authNow });
    await seedDead(authFail.cache, APP_A);
    authFail.http.authOk = false;
    await expect(createMessage(authFail.channel)).rejects.toBeTruthy();
    expect(authFail.http.authPosts).toBe(1);
    expect(authFail.http.apiCalls).toHaveLength(1);
    await expect(createMessage(authFail.channel)).rejects.toBeTruthy();
    expect(authFail.http.authPosts).toBe(1);
    authNow += FEISHU_TOKEN_RETRY_COOLDOWN_MS;
    await expect(createMessage(authFail.channel)).rejects.toBeTruthy();
    expect(authFail.http.authPosts).toBe(2);
  });

  it('eviction deletes the cache entry so get returns undefined (not expiredTime 0)', async () => {
    const h = harness(APP_A);
    await seedDead(h.cache, APP_A);
    let sawEmpty = false;
    h.http.onAuth = async () => {
      const cached = await h.cache.get(CTenantAccessToken, { namespace: APP_A });
      sawEmpty = cached === undefined;
    };
    await createMessage(h.channel);
    expect(sawEmpty).toBe(true);
    expect(h.cache.values.get(tenantAccessTokenCacheKey(APP_A))?.expiredTime).not.toBe(0);
  });

  it('rejection on one appId does not evict or refresh another channel', async () => {
    const shared = new DefaultCache();
    const a = harness(APP_A, { cache: shared });
    const b = harness(APP_B, { cache: shared });
    await seedDead(a.cache, APP_A);
    await seedDead(b.cache, APP_B);
    b.http.api = { type: 'ok' };

    await createMessage(a.channel);
    expect(a.http.authPosts).toBe(1);
    expect(b.http.authPosts).toBe(0);
    expect(await shared.get(CTenantAccessToken, { namespace: APP_B })).toBe(DEAD_TOKEN);
    expect(await shared.get(CTenantAccessToken, { namespace: APP_A })).toBe(FRESH_TOKEN);

    const listed = await b.channel.rawClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_b', msg_type: 'text', content: JSON.stringify({ text: 'b' }) },
    }) as { code?: number };
    expect(listed.code).toBe(0);
    expect(b.http.authPosts).toBe(0);
    expect(apiAuths(b.http)).toEqual([DEAD_TOKEN]);
  });

  it('caller Authorization and non-D2 codes are not replayed', async () => {
    const h = harness(APP_A);
    await seedDead(h.cache, APP_A);

    h.http.api = { type: 'http', status: 400, code: 99991663 };
    await expect(
      h.channel.rawClient.im.v1.message.create(
        {
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: 'oc_chat', msg_type: 'text', content: JSON.stringify({ text: 'u' }) },
        },
        withUserAccessToken(USER_TOKEN) as never,
      ),
    ).rejects.toMatchObject({ response: { data: { code: 99991663 } } });
    expect(h.http.authPosts).toBe(0);
    expect(apiAuths(h.http)).toEqual([USER_TOKEN]);

    for (const script of [
      { type: 'http', status: 400, code: 99991664 },
      { type: 'http', status: 400, code: 99991672 },
      { type: 'http', status: 400, code: 230002 },
      { type: 'status', status: 503 },
    ] as const) {
      h.http.apiCalls = [];
      h.http.api = script;
      await seedDead(h.cache, APP_A);
      const posts = h.http.authPosts;
      await expect(createMessage(h.channel)).rejects.toBeTruthy();
      expect(h.http.authPosts).toBe(posts);
      expect(h.http.apiCalls).toHaveLength(1);
    }
  });

  it('messageResource.get with a 400/99991663 stream body self-heals and returns attachment bytes', async () => {
    const h = harness(APP_A);
    await seedDead(h.cache, APP_A);
    const got = await h.channel.rawClient.im.v1.messageResource.get({
      path: { message_id: 'om_1', file_key: 'file_1' },
      params: { type: 'file' },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of got.getReadableStream()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(chunks).toString()).toBe('attachment-bytes');
    expect(h.http.authPosts).toBe(1);
    expect(apiAuths(h.http)).toEqual([DEAD_TOKEN, FRESH_TOKEN]);
  });

  it('rethrows a streamed 4xx with the body still readable when it is not JSON', async () => {
    const h = harness(APP_A);
    await seedDead(h.cache, APP_A);
    h.http.streamErrorBody = 'not-json-error-body';
    const err = await h.channel.rawClient.im.v1.messageResource.get({
      path: { message_id: 'om_1', file_key: 'file_1' },
      params: { type: 'file' },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(err).toBeTruthy();
    const data = (err as { response?: { data?: unknown } }).response?.data;
    expect(data).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const chunk of data as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(chunks).toString()).toBe('not-json-error-body');
    expect(h.http.authPosts).toBe(0);
  });

  it('a streamed 4xx whose body never ends rejects the original error within 2s with no auth POST or replay', async () => {
    const h = harness(APP_A);
    await seedDead(h.cache, APP_A);
    const prefix = JSON.stringify({ code: 99991663, msg: 'token invalid' });
    const hang = new Readable({ read() {} });
    hang.push(Buffer.from(prefix));
    h.http.streamErrorBody = hang;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let settled: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
    const pending = h.channel.rawClient.im.v1.messageResource.get({
      path: { message_id: 'om_1', file_key: 'file_1' },
      params: { type: 'file' },
    }).then(
      (value) => {
        settled = { ok: true, value };
        return settled;
      },
      (error: unknown) => {
        settled = { ok: false, error };
        return settled;
      },
    );

    await vi.advanceTimersByTimeAsync(FEISHU_STREAM_ERROR_BODY_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    expect(h.http.authPosts).toBe(0);
    expect(h.http.apiCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(h.http.authPosts).toBe(0);
    expect(h.http.apiCalls).toHaveLength(1);
    expect(apiAuths(h.http)).toEqual([DEAD_TOKEN]);
    const err = (out as { ok: false; error: unknown }).error as {
      response?: { status?: number; data?: unknown };
    };
    expect(err.response?.status).toBe(400);
    expect(err.response?.data).toBeInstanceOf(Readable);

    hang.push(Buffer.from('-tail'));
    hang.push(null);
    const chunks: Buffer[] = [];
    for await (const chunk of err.response!.data as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(chunks).toString()).toBe(`${prefix}-tail`);
  });

  it('startChannel installs token retry after createLarkChannel and before connect', () => {
    const src = readFileSync(join(process.cwd(), 'src/bot/channel.ts'), 'utf8');
    const create = src.indexOf('const channel = createLarkChannel(opts)');
    const install = src.indexOf('installFeishuTokenRetry(channel)');
    const link = src.indexOf('startFeishuLink(');
    const connect = src.indexOf('await channel.connect()');
    expect(create).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(create);
    expect(link).toBeGreaterThan(install);
    expect(connect).toBeGreaterThan(install);
  });
});

function harness(
  appId: string,
  opts?: { cache?: SdkCache; now?: () => number },
): { channel: LarkChannel; cache: SdkCache; http: FakeHttp } {
  const cache = opts?.cache ?? new DefaultCache();
  const http = createFakeHttp();
  const channel = createLarkChannel({
    appId,
    appSecret: `${appId}-secret`,
    domain: 'https://open.feishu.cn',
    cache,
    httpInstance: http as never,
    logger: SILENT as never,
  });
  installFeishuTokenRetry(channel, opts?.now ? { now: opts.now } : undefined);
  return { channel, cache, http };
}

function createFakeHttp(): FakeHttp {
  const http: FakeHttp = {
    authPosts: 0,
    apiCalls: [],
    calls: [],
    authOk: true,
    replaySucceeds: true,
    api: { type: 'http', status: 400, code: 99991663 },
    request: async (opts) => {
      const url = String(opts.url ?? '');
      const method = String(opts.method ?? 'GET');
      if (isAuthUrl(url)) {
        return http.post(url, opts.data);
      }
      const authorization = headerAuth(opts.headers);
      const call: RecordedCall = { kind: 'api', method, url, ...(authorization ? { authorization } : {}) };
      http.calls.push(call);
      http.apiCalls.push(call);
      await http.beforeApi?.(call, http.apiCalls.length);
      const token = bearer(authorization);
      if (opts.responseType === 'stream') {
        if (token === FRESH_TOKEN && http.replaySucceeds) {
          return {
            data: Readable.from([Buffer.from('attachment-bytes')]),
            headers: { 'content-type': 'application/octet-stream' },
          };
        }
        if (http.streamErrorBody instanceof Readable) {
          throw axiosHttp(400, http.streamErrorBody);
        }
        const body = http.streamErrorBody
          ?? JSON.stringify({ code: 99991663, msg: 'token invalid' });
        throw axiosHttp(400, Readable.from([
          typeof body === 'string' ? Buffer.from(body) : body,
        ]));
      }
      if (http.api.type === 'ok') return successBody(url);
      if (token === FRESH_TOKEN && http.replaySucceeds) return successBody(url);
      return failApi(http.api);
    },
    post: async (url) => {
      const call: RecordedCall = { kind: 'auth', method: 'POST', url };
      http.calls.push(call);
      if (!isAuthUrl(url)) {
        throw new Error(`unexpected post ${url}`);
      }
      http.authPosts += 1;
      await http.onAuth?.();
      if (!http.authOk) {
        throw Object.assign(new Error('auth endpoint failed'), { isAxiosError: true });
      }
      return { code: 0, tenant_access_token: FRESH_TOKEN, expire: 7200 };
    },
    get: unsupported('get'),
    delete: unsupported('delete'),
    head: unsupported('head'),
    options: unsupported('options'),
    put: unsupported('put'),
    patch: unsupported('patch'),
  };
  return http;
}

function unsupported(name: string): (...args: unknown[]) => Promise<unknown> {
  return async () => {
    throw new Error(`fake http ${name} not implemented`);
  };
}

function successBody(url: string): { code: number; data: Record<string, unknown> } {
  if (url.includes('/application/v6/applications/')) {
    return {
      code: 0,
      data: { app: { owner: { owner_id: 'ou_owner' }, app_name: 'retry-bot' } },
    };
  }
  if (url.includes('/im/v1/messages')) {
    return { code: 0, data: { message_id: 'om_ok' } };
  }
  return { code: 0, data: { ok: true } };
}

function failApi(script: ApiScript): never | { code: number; msg: string } {
  switch (script.type) {
    case 'ok':
      return { code: 0, msg: 'ok' };
    case 'resolved':
      return { code: script.code, msg: `resolved ${script.code}` };
    case 'http':
      throw axiosHttp(script.status, { code: script.code, msg: `code ${script.code}` });
    case 'status':
      throw axiosHttp(script.status, { msg: `HTTP ${script.status}` });
    default: {
      const _exhaustive: never = script;
      throw _exhaustive;
    }
  }
}

function axiosHttp(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
}

async function seedDead(cache: SdkCache, appId: string): Promise<void> {
  await cache.set(CTenantAccessToken, DEAD_TOKEN, Date.now() + 3_600_000, { namespace: appId });
}

async function createMessage(channel: LarkChannel): Promise<{ data?: { message_id?: string } }> {
  return channel.rawClient.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: 'oc_chat',
      msg_type: 'text',
      content: JSON.stringify({ text: 'hi' }),
    },
  }) as Promise<{ data?: { message_id?: string } }>;
}

function apiAuths(http: FakeHttp): string[] {
  return http.apiCalls.map((c) => bearer(c.authorization)).filter((t): t is string => Boolean(t));
}

function headerAuth(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const rec = headers as Record<string, unknown> & { get?: (k: string) => unknown };
  const direct = rec.Authorization ?? rec.authorization;
  if (typeof direct === 'string') return direct;
  if (typeof rec.get === 'function') {
    const value = rec.get('Authorization') ?? rec.get('authorization');
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function bearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  return authorization.replace(/^Bearer\s+/i, '');
}

function isAuthUrl(url: string): boolean {
  return url.includes('/open-apis/auth/v3/tenant_access_token');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function assertNoTokenInLogs(
  warn: ReturnType<typeof vi.spyOn>,
  info: ReturnType<typeof vi.spyOn>,
): void {
  const blobs = [...warn.mock.calls, ...info.mock.calls].map((c) => JSON.stringify(c));
  for (const blob of blobs) {
    expect(blob).not.toContain(DEAD_TOKEN);
    expect(blob).not.toContain(FRESH_TOKEN);
    expect(blob).not.toContain(USER_TOKEN);
  }
}
