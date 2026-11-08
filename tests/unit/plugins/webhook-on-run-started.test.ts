import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterFactory, TelemetryEvent } from '../../../src/core/telemetry.js';
import { specTaskKey } from '../../helpers/spec-task-key.js';

const HOOK_URL = 'https://example.invalid/run-started';
const HOOK_KEY = 'dummy-hook-key-000';
const PROFILE = 'claude';
const CHAT_ID = 'oc_abcdefghijklmnopqrstuvwxyz123456';
const MESSAGE_ID = 'om_source_message_abcdef789012';
const TASK_KEY = specTaskKey(PROFILE, CHAT_ID, MESSAGE_ID);
const TASK_KEY_HTTP = specTaskKey(PROFILE, CHAT_ID, `${MESSAGE_ID}-http`);
const TASK_KEY_NET = specTaskKey(PROFILE, CHAT_ID, `${MESSAGE_ID}-net`);
const RUN_A = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const RUN_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TS = '2026-05-25T00:00:00.000+00:00';
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_MAX_KEYS = 1000;

const ENV_KEYS = [
  'LARK_RUN_STARTED_WEBHOOK_URL',
  'LARK_RUN_STARTED_WEBHOOK_KEY',
  'LARK_RUN_STARTED_WEBHOOK_TIMEOUT_MS',
  'LARK_RUN_STARTED_BOT_NAME',
] as const;

async function loadFactory(): Promise<AdapterFactory> {
  const specifier = pathToFileURL(
    join(process.cwd(), 'plugins/webhook-on-run-started/index.mjs'),
  ).href;
  const mod = await import(specifier) as { default?: AdapterFactory; createAdapter?: AdapterFactory };
  const factory = mod.default ?? mod.createAdapter;
  expect(factory).toBeTypeOf('function');
  return factory as AdapterFactory;
}

function startedEvent(overrides: {
  runId?: string;
  taskKey?: string | undefined;
  phase?: string;
  event?: string;
  fields?: Record<string, unknown>;
} = {}): TelemetryEvent {
  const runId = overrides.runId ?? RUN_A;
  const fields: Record<string, unknown> = {
    runId,
    agent: 'claude',
    scope: '...zzzzzz',
    profile: PROFILE,
    ...(overrides.taskKey !== undefined ? { taskKey: overrides.taskKey } : {}),
    ...overrides.fields,
  };
  if (overrides.taskKey === undefined && !('taskKey' in (overrides.fields ?? {})) && !('taskKey' in overrides)) {
    delete fields.taskKey;
  }
  return {
    level: 'info',
    phase: overrides.phase ?? 'run',
    event: overrides.event ?? 'started',
    ts: TS,
    ctx: { chatId: '...123456', msgId: '...789012' },
    fields,
  };
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe('webhook-on-run-started plugin', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('POSTs only run/started events', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });

    adapter.emit(startedEvent({ phase: 'run', event: 'completed', runId: RUN_A }));
    adapter.emit(startedEvent({ phase: 'intake', event: 'enter', runId: RUN_A }));
    expect(fetchMock).not.toHaveBeenCalled();

    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('sends the D2 payload with key equal to task_key', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    process.env.LARK_RUN_STARTED_BOT_NAME = 'keeper-bot';
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });

    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HOOK_URL);
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toEqual({
      v: 1,
      type: 'run.started',
      key: TASK_KEY,
      task_key: TASK_KEY,
      bot: 'keeper-bot',
      scope: '...zzzzzz',
      chat_id: '...123456',
      thread_id: null,
      message_id: '...789012',
      run_id: RUN_A,
      agent: 'claude',
      ts: TS,
    });
    expect(Object.keys(payload).sort()).toEqual([
      'agent',
      'bot',
      'chat_id',
      'key',
      'message_id',
      'run_id',
      'scope',
      'task_key',
      'thread_id',
      'ts',
      'type',
      'v',
    ]);
    expect(JSON.stringify(payload)).not.toContain(CHAT_ID);
    expect(JSON.stringify(payload)).not.toContain(MESSAGE_ID);
  });

  it('does not resend the same task_key with a different run_id within TTL', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });

    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_B }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      key: string;
      task_key: string;
      run_id: string;
    };
    expect(payload.key).toBe(TASK_KEY);
    expect(payload.task_key).toBe(TASK_KEY);
    expect(payload.run_id).toBe(RUN_A);
  });

  it('keeps the same task_key after a simulated restart with a fresh adapter', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    const first = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    first.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    vi.resetModules();
    const second = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    second.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_B }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const keys = fetchMock.mock.calls.map((call) => (JSON.parse(String((call[1] as RequestInit).body)) as { key: string }).key);
    expect(keys).toEqual([TASK_KEY, TASK_KEY]);
  });

  it('falls back to run_id when taskKey is absent and sets task_key null', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    adapter.emit(startedEvent({ runId: RUN_A }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(payload.key).toBe(RUN_A);
    expect(payload.task_key).toBeNull();
    expect(payload.run_id).toBe(RUN_A);
    expect(Object.prototype.hasOwnProperty.call(payload, 'task_key')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(payload, 'thread_id')).toBe(true);
  });

  it('sends both auth headers when a key is configured, and none when it is not', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    process.env.LARK_RUN_STARTED_WEBHOOK_KEY = HOOK_KEY;
    const withKey = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    withKey.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const authorized = headersOf(fetchMock.mock.calls[0]?.[1] as RequestInit);
    expect(authorized.get('Authorization')).toBe(`Bearer ${HOOK_KEY}`);
    expect(authorized.get('X-Automation-Key')).toBe(HOOK_KEY);

    delete process.env.LARK_RUN_STARTED_WEBHOOK_KEY;
    vi.resetModules();
    fetchMock.mockClear();
    const withoutKey = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    withoutKey.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_B }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const anonymous = headersOf(fetchMock.mock.calls[0]?.[1] as RequestInit);
    expect(anonymous.get('Authorization')).toBeNull();
    expect(anonymous.get('X-Automation-Key')).toBeNull();
  });

  it('returns from emit before fetch settles', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    let release: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(4000);
    expect(release).toBeTypeOf('function');
    release?.(new Response(null, { status: 204 }));
  });

  it('warns without throwing on timeout, HTTP 500, and network errors', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    process.env.LARK_RUN_STARTED_WEBHOOK_KEY = HOOK_KEY;
    process.env.LARK_RUN_STARTED_WEBHOOK_TIMEOUT_MS = '3000';

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      queueMicrotask(() => controller.abort(new DOMException('Aborted', 'AbortError')));
      return controller.signal;
    });
    fetchMock.mockImplementation((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        });
      }),
    );

    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    expect(() => adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }))).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(timeoutSpy).toHaveBeenCalledWith(3000);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(HOOK_URL);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(HOOK_KEY);

    timeoutSpy.mockRestore();
    warn.mockClear();
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    expect(() => adapter.emit(startedEvent({ taskKey: TASK_KEY_HTTP, runId: RUN_B }))).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(JSON.stringify(warn.mock.calls)).toContain('500');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(HOOK_URL);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(HOOK_KEY);

    warn.mockClear();
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' }));
    expect(() => adapter.emit(startedEvent({ taskKey: TASK_KEY_NET, runId: RUN_B }))).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(JSON.stringify(warn.mock.calls)).toMatch(/TypeError|fetch failed/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(HOOK_URL);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(HOOK_KEY);
  });

  it('does not follow redirects and warns once on 3xx without leaking secrets', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    process.env.LARK_RUN_STARTED_WEBHOOK_KEY = HOOK_KEY;
    fetchMock.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://example.invalid/elsewhere' },
    }));
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).redirect).toBe('manual');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(warn.mock.calls)).toContain('302');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(HOOK_URL);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(HOOK_KEY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('elsewhere');
  });

  it('is a noop when the webhook URL is unset', async () => {
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    adapter.recordError(new Error('ignored'));
    adapter.recordMetric('n', 1);
    await adapter.flush?.(50);
    await adapter.close?.();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('warns once at startup when the webhook URL is unset, across many events', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_KEY = HOOK_KEY;
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    expect(warn).toHaveBeenCalledTimes(1);
    const notice = JSON.stringify(warn.mock.calls);
    expect(notice).toMatch(/inactive|unset/i);
    expect(notice).not.toContain(HOOK_URL);
    expect(notice).not.toContain(HOOK_KEY);
    expect(notice).not.toMatch(/https?:\/\//i);

    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_B }));
    adapter.emit(startedEvent({ runId: RUN_A }));
    adapter.recordError(new Error('ignored'));
    adapter.recordMetric('n', 1);
    await adapter.flush?.(50);
    await adapter.close?.();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to meta.appId for bot when the bot name env and profile are unset', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_fallback_app' });
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A, fields: { profile: undefined } }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { bot: string };
    expect(payload.bot).toBe('cli_fallback_app');
  });

  it('labels bot with the emitting run profile, not the adapter meta appId', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_alpha' });
    adapter.emit(startedEvent({
      taskKey: TASK_KEY,
      runId: RUN_A,
      fields: { profile: 'beta-profile' },
    }));
    adapter.emit(startedEvent({
      taskKey: TASK_KEY_HTTP,
      runId: RUN_B,
      fields: { profile: 'gamma-profile' },
    }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const bots = fetchMock.mock.calls.map(
      (call) => (JSON.parse(String((call[1] as RequestInit).body)) as { bot: string }).bot,
    );
    expect(bots).toEqual(['beta-profile', 'gamma-profile']);
  });

  it('does not merge distinct runs that have no task_key', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    adapter.emit(startedEvent({ runId: RUN_A }));
    adapter.emit(startedEvent({ runId: RUN_B }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as {
      key: string;
      task_key: string | null;
      run_id: string;
    });
    expect(payloads[0]?.key).toBe(RUN_A);
    expect(payloads[1]?.key).toBe(RUN_B);
    expect(payloads[0]?.task_key).toBeNull();
    expect(payloads[1]?.task_key).toBeNull();

    adapter.emit(startedEvent({ runId: RUN_A }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('suppresses a repeat within TTL and resends after TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });

    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z').getTime() + DEDUPE_TTL_MS - 1);
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_B }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z').getTime() + DEDUPE_TTL_MS);
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_B }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      key: string;
      run_id: string;
    };
    expect(second.key).toBe(TASK_KEY);
    expect(second.run_id).toBe(RUN_B);
  });

  it('evicts the least-recently-used key when the LRU is full', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    for (let i = 0; i < DEDUPE_MAX_KEYS; i++) {
      adapter.emit(startedEvent({
        taskKey: `k${String(i).padStart(4, '0')}`,
        runId: `run-${i}`,
      }));
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(DEDUPE_MAX_KEYS));

    adapter.emit(startedEvent({ taskKey: 'k0000', runId: 'run-0-touch' }));
    expect(fetchMock).toHaveBeenCalledTimes(DEDUPE_MAX_KEYS);

    adapter.emit(startedEvent({ taskKey: 'k1000', runId: 'run-1000' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(DEDUPE_MAX_KEYS + 1));

    adapter.emit(startedEvent({ taskKey: 'k0000', runId: 'run-0-again' }));
    expect(fetchMock).toHaveBeenCalledTimes(DEDUPE_MAX_KEYS + 1);

    adapter.emit(startedEvent({ taskKey: 'k0001', runId: 'run-1-again' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(DEDUPE_MAX_KEYS + 2));
  });

  it('flush waits for in-flight POSTs and bounds the wait', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    let release: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    let flushed = false;
    const waiting = Promise.resolve(adapter.flush?.()).then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    release?.(new Response(null, { status: 204 }));
    await waiting;
    expect(flushed).toBe(true);

    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    adapter.emit(startedEvent({ taskKey: TASK_KEY_HTTP, runId: RUN_B }));
    const started = Date.now();
    await adapter.flush?.(50);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not schedule a flush timer when nothing is in flight', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    await adapter.flush?.(2000);
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it('clears the flush timeout when in-flight POSTs settle', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    let release: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const flushing = adapter.flush?.(5000);
    expect(timeoutSpy).toHaveBeenCalled();
    const handle = timeoutSpy.mock.results.at(-1)?.value as ReturnType<typeof setTimeout>;
    release?.(new Response(null, { status: 204 }));
    await flushing;
    expect(clearSpy).toHaveBeenCalledWith(handle);
  });

  it('close aborts in-flight POSTs and ignores later emits', async () => {
    process.env.LARK_RUN_STARTED_WEBHOOK_URL = HOOK_URL;
    fetchMock.mockImplementation((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        });
      }),
    );
    const adapter = (await loadFactory())({ version: 'test', appId: 'cli_test_app' });
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_A }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    adapter.close?.();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(JSON.stringify(warn.mock.calls)).not.toContain(HOOK_URL);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(HOOK_KEY);

    fetchMock.mockClear();
    adapter.emit(startedEvent({ taskKey: TASK_KEY, runId: RUN_B }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
