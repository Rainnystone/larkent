import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLarkChannel, type LarkChannel } from '@larksuite/channel';
import { log } from '../../../src/core/logger';
import { COT_REQUEST_TIMEOUT_MS, CotClient } from '../../../src/bot/cot';
import { installFeishuTokenRetry } from '../../../src/bot/feishu-token-retry';
import { createFeishuProbe, startFeishuLink, type Outage } from '../../../src/bot/feishu-link';

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(
  createRequire(require.resolve('@larksuite/channel')).resolve('@larksuiteoapi/node-sdk'),
);
const { DefaultCache, CTenantAccessToken } = sdkRequire('@larksuiteoapi/node-sdk') as {
  DefaultCache: new () => SdkCache;
  CTenantAccessToken: symbol;
};

interface SdkCache {
  get: (key: unknown, options?: { namespace?: string }) => Promise<unknown>;
  set: (
    key: unknown,
    value: unknown,
    expiredTime?: number,
    options?: { namespace?: string },
  ) => Promise<boolean>;
}

const DEAD_TOKEN = 'dead-tenant-tok-aaa';
const FRESH_TOKEN = 'fresh-tenant-tok-bbb';
const APP_A = 'cli_token_exhausted_a';
const SILENT = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
};

interface RecordedCall {
  kind: 'auth' | 'api';
  method: string;
  url: string;
  authorization?: string;
  timeout?: number;
}

interface FakeHttp {
  authPosts: number;
  apiCalls: RecordedCall[];
  replaySucceeds: boolean;
  hangApi: boolean;
  onAuth?: () => Promise<void> | void;
  api: { type: 'http'; status: number; code: number } | { type: 'status'; status: number };
  request: (opts: Record<string, unknown>) => Promise<unknown>;
  get: (...args: unknown[]) => Promise<unknown>;
  delete: (...args: unknown[]) => Promise<unknown>;
  head: (...args: unknown[]) => Promise<unknown>;
  options: (...args: unknown[]) => Promise<unknown>;
  post: (url: string, data?: unknown) => Promise<unknown>;
  put: (...args: unknown[]) => Promise<unknown>;
  patch: (...args: unknown[]) => Promise<unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('exhausted tenant token is a link failure (ticket 02)', () => {
  it('probe with exhausted 99991663 reports down, keeps lastLiveAt, does not loop recovery or restart, and throttles link.auth-unhealthy', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const lastLiveAt = 1_700_000_000_000;
    let now = lastLiveAt + 60_000;
    const h = harness(APP_A);
    await seedDead(h.cache, APP_A);
    h.http.replaySucceeds = false;
    h.channel.getConnectionStatus = () => ({ state: 'connected', reconnectAttempts: 0 });

    const watermark = memoryWatermark(lastLiveAt);
    const reconnect = vi.fn();
    const restart = vi.fn();
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: h.channel,
      probe: createFeishuProbe(h.channel),
      watermark,
      now: () => now,
      reconnect,
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });

    await link.tick();
    expect(link.isDown()).toBe(true);
    expect(watermark.get()).toBe(lastLiveAt);
    expect(recovered).toEqual([]);
    expect(reconnect).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();

    now += 15_000;
    await link.tick();
    now += 15_000;
    await link.tick();
    expect(link.isDown()).toBe(true);
    expect(watermark.get()).toBe(lastLiveAt);
    expect(recovered).toEqual([]);
    expect(reconnect).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();

    const unhealthy = warn.mock.calls.filter((c) => c[0] === 'link' && c[1] === 'auth-unhealthy');
    expect(unhealthy).toHaveLength(1);
    expect(unhealthy[0]?.[2]).toMatchObject({
      appId: APP_A,
      code: 99991663,
      outcome: 'probe-down',
    });
    const blobs = [...warn.mock.calls, ...info.mock.calls].map((c) => JSON.stringify(c));
    for (const blob of blobs) {
      expect(blob).not.toContain(DEAD_TOKEN);
      expect(blob).not.toContain(FRESH_TOKEN);
      expect(blob).not.toMatch(/"token"|"secret"|"authorization"/i);
    }
    link.stop();
  });

  it('CotClient create self-heals a stale 99991663 through rawClient.request with one auth POST and one replay', async () => {
    const h = harness(APP_A);
    await seedDead(h.cache, APP_A);
    const cot = cotOn(h);
    const created = await cot.create('oc_chat', 'om_origin');
    expect(created).toMatchObject({ cot_id: 'cot_ok', message_id: 'om_cot' });
    expect(h.http.authPosts).toBe(1);
    expect(apiAuths(h.http)).toEqual([DEAD_TOKEN, FRESH_TOKEN]);
    expect(h.http.apiCalls.every((c) => c.url.includes('/im/v1/message_cot'))).toBe(true);
  });

  it('CotClient create does not retry 5xx or timeout and keeps the 15s bound', async () => {
    const h = harness(APP_A);
    await seedDead(h.cache, APP_A);
    h.http.api = { type: 'status', status: 503 };
    const cot = cotOn(h);
    await expect(cot.create('oc_chat', 'om_origin')).rejects.toBeTruthy();
    expect(h.http.apiCalls).toHaveLength(1);
    expect(h.http.authPosts).toBe(0);

    h.http.apiCalls = [];
    h.http.hangApi = true;
    h.http.api = { type: 'http', status: 400, code: 99991663 };
    vi.useFakeTimers();
    const pending = expect(cot.create('oc_chat', 'om_origin')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await vi.advanceTimersByTimeAsync(COT_REQUEST_TIMEOUT_MS);
    await pending;
    expect(h.http.apiCalls).toHaveLength(1);
    expect(h.http.apiCalls[0]?.timeout).toBe(COT_REQUEST_TIMEOUT_MS);
  });

  it('a slow self-heal past 15s never sends the create replay late', async () => {
    const h = harness(APP_A);
    await seedDead(h.cache, APP_A);
    const hung = deferred();
    const released = deferred();
    h.http.onAuth = () => {
      hung.resolve();
      return released.promise;
    };
    const cot = cotOn(h);
    vi.useFakeTimers();
    const pending = expect(cot.create('oc_chat', 'om_origin')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await hung.promise;
    expect(h.http.apiCalls).toHaveLength(1);
    expect(h.http.apiCalls.every((c) => c.url.includes('/im/v1/message_cot'))).toBe(true);
    expect(h.http.authPosts).toBe(1);

    await vi.advanceTimersByTimeAsync(COT_REQUEST_TIMEOUT_MS);
    await pending;
    expect(h.http.apiCalls).toHaveLength(1);

    released.resolve();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.http.apiCalls).toHaveLength(1);
    expect(apiAuths(h.http)).toEqual([DEAD_TOKEN]);
  });

  it('startChannel constructs CotClient on channel.rawClient.request after token retry is installed', () => {
    const src = readFileSync(join(process.cwd(), 'src/bot/channel.ts'), 'utf8');
    const create = src.indexOf('const channel = createLarkChannel(opts)');
    const install = src.indexOf('installFeishuTokenRetry(channel)');
    const cot = src.indexOf('new CotClient({');
    expect(create).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(create);
    expect(cot).toBeGreaterThan(install);
    expect(src).toMatch(/request:\s*\(payload\)\s*=>\s*channel\.rawClient\.request\(payload\)/);
  });
});

function cotOn(h: { channel: LarkChannel }): CotClient {
  return new CotClient({
    tenant: 'feishu',
    appId: APP_A,
    appSecret: `${APP_A}-secret`,
    request: (payload) => h.channel.rawClient.request(payload),
  });
}

function apiAuths(http: FakeHttp): string[] {
  return http.apiCalls.map((c) => bearer(c.authorization)).filter((t): t is string => Boolean(t));
}

function harness(appId: string): { channel: LarkChannel; cache: SdkCache; http: FakeHttp } {
  const cache = new DefaultCache();
  const http = createFakeHttp();
  const channel = createLarkChannel({
    appId,
    appSecret: `${appId}-secret`,
    domain: 'https://open.feishu.cn',
    cache,
    httpInstance: http as never,
    logger: SILENT as never,
  });
  installFeishuTokenRetry(channel);
  return { channel, cache, http };
}

function createFakeHttp(): FakeHttp {
  const http: FakeHttp = {
    authPosts: 0,
    apiCalls: [],
    replaySucceeds: true,
    hangApi: false,
    api: { type: 'http', status: 400, code: 99991663 },
    request: async (opts) => {
      const url = String(opts.url ?? '');
      const method = String(opts.method ?? 'GET');
      if (url.includes('/open-apis/auth/v3/tenant_access_token')) {
        return http.post(url);
      }
      const authorization = headerAuth(opts.headers);
      const timeout = typeof opts.timeout === 'number' ? opts.timeout : undefined;
      const call: RecordedCall = {
        kind: 'api',
        method,
        url,
        ...(authorization ? { authorization } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      };
      http.apiCalls.push(call);
      if (http.hangApi) return new Promise(() => {});
      const token = bearer(authorization);
      if (token === FRESH_TOKEN && http.replaySucceeds) return successBody(url);
      if (http.api.type === 'status') {
        throw axiosHttp(http.api.status, { msg: `HTTP ${http.api.status}` });
      }
      throw axiosHttp(http.api.status, { code: http.api.code, msg: `code ${http.api.code}` });
    },
    post: async (url) => {
      if (!url.includes('/open-apis/auth/v3/tenant_access_token')) {
        throw new Error(`unexpected post ${url}`);
      }
      http.authPosts += 1;
      await http.onAuth?.();
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

function successBody(url: string): { code: number; data: Record<string, unknown> } {
  if (url.includes('/application/v6/applications/')) {
    return {
      code: 0,
      data: { app: { owner: { owner_id: 'ou_owner' }, app_name: 'retry-bot' } },
    };
  }
  if (url.includes('/im/v1/message_cot')) {
    return { code: 0, data: { cot_id: 'cot_ok', message_id: 'om_cot' } };
  }
  return { code: 0, data: { ok: true } };
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

function unsupported(name: string): (...args: unknown[]) => Promise<unknown> {
  return async () => {
    throw new Error(`fake http ${name} not implemented`);
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function memoryWatermark(initial?: number): { get(): number | undefined; set(at: number): void } {
  let value = initial;
  return {
    get: () => value,
    set: (at) => {
      value = at;
    },
  };
}
