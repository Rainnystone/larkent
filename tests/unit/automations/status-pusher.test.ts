import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../src/core/logger';
import {
  STATUS_PUSH_DEBOUNCE_MS,
  STATUS_PUSH_RETRY_MAX_MS,
  STATUS_PUSH_RETRY_MIN_MS,
  STATUS_PUSH_SIGNATURE_HEADER,
  STATUS_PUSH_TIMEOUT_MS,
  STATUS_PUSH_TIMESTAMP_HEADER,
  signStatusPush,
} from '../../../src/automations/status-push';
import { createStatusPusher } from '../../../src/automations/status-pusher';
import { AutomationsStore, type CreateAutomationInput } from '../../../src/automations/store';

const SECRET = 'unit-status-secret';
const ENDPOINT = 'https://status.test';
const PROFILE = 'test-profile';
const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const HOUR = 60 * 60_000;
const dirs: string[] = [];
const pushers: Array<{ stop(): void }> = [];

afterEach(async () => {
  for (const pusher of pushers.splice(0).reverse()) pusher.stop();
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

class ManualClock {
  nowMs: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(nowMs: number) {
    this.nowMs = nowMs;
  }

  now = (): number => this.nowMs;

  setTimeout = (fn: () => void, delayMs: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.nowMs + Math.max(0, delayMs), fn });
    return id;
  };

  clearTimeout = (id: unknown): void => {
    if (typeof id === 'number') this.timers.delete(id);
  };

  async advanceTo(target: number, idle: () => Promise<void>): Promise<void> {
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const first = due[0];
      if (!first) {
        this.nowMs = Math.max(this.nowMs, target);
        return;
      }
      this.nowMs = Math.max(this.nowMs, first[1].at);
      this.timers.delete(first[0]);
      first[1].fn();
      await idle();
    }
  }
}

async function harness(opts: {
  endpoint?: string;
  secret?: string;
  nowMs?: number;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'status-pusher-'));
  dirs.push(dir);
  const clock = new ManualClock(opts.nowMs ?? NOW);
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'automations-status.json'),
    now: clock.now,
  });
  await store.load();
  const posts: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    posts.push({
      url: String(input),
      headers: headersOf(init?.headers),
      body: String(init?.body ?? ''),
    });
    return new Response(null, { status: 204 });
  });
  const pusher = createStatusPusher({
    endpoint: opts.endpoint,
    secret: opts.secret,
    profile: PROFILE,
    store,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetch: fetchImpl as typeof fetch,
  });
  pushers.push(pusher);
  return { clock, store, pusher, posts, fetchImpl };
}

function headersOf(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = new Headers(headers);
  raw.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function reminderInput(): CreateAutomationInput {
  return {
    taskType: 'reminder',
    schedule: {
      kind: 'interval',
      timezone: 'UTC',
      everyMs: HOUR,
      startAt: NOW,
      endAt: NOW + 365 * 24 * HOUR,
    },
    timezone: 'UTC',
    startAt: NOW,
    endAt: NOW + 365 * 24 * HOUR,
    nextFireAt: NOW + HOUR,
    chatId: 'oc_group',
    createdBy: 'ou_alice',
    name: '交周报',
    taskText: 'secret ping body',
  };
}

describe('status pusher', () => {
  it('does not POST when endpoint or secret is missing', async () => {
    const none = await harness();
    await none.store.create(reminderInput());
    await none.store.writeStatus('Grok Bot');
    none.pusher.notify();
    await none.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS + 1, () => none.pusher.idle());
    expect(none.posts).toEqual([]);

    const noSecret = await harness({ endpoint: ENDPOINT });
    noSecret.pusher.notify();
    await noSecret.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS + 1, () => noSecret.pusher.idle());
    expect(noSecret.posts).toEqual([]);
  });

  it('merges rapid notifies into one signed POST within a few seconds', async () => {
    const h = await harness({ endpoint: ENDPOINT, secret: SECRET });
    await h.store.create(reminderInput());
    await h.store.writeStatus('Grok Bot');
    h.pusher.notify();
    h.pusher.notify();
    expect(h.posts).toEqual([]);
    await h.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS, () => h.pusher.idle());
    expect(h.posts).toHaveLength(1);
    expect(STATUS_PUSH_DEBOUNCE_MS).toBeLessThanOrEqual(5_000);
    const post = h.posts[0]!;
    expect(post.url).toBe('https://status.test/v1/status');
    const body = JSON.parse(post.body) as { v: number; updatedAt: number; items: unknown[] };
    expect(body.v).toBe(2);
    const timestamp = post.headers[STATUS_PUSH_TIMESTAMP_HEADER];
    expect(timestamp).toBe(String(NOW + STATUS_PUSH_DEBOUNCE_MS));
    expect(post.headers[STATUS_PUSH_SIGNATURE_HEADER]).toBe(
      signStatusPush(SECRET, timestamp!, post.body),
    );
    expect(JSON.stringify(h.posts)).not.toContain(SECRET);
  });

  it('posts the same items twice with a strictly increasing updatedAt, including after reload', async () => {
    const h = await harness({ endpoint: ENDPOINT, secret: SECRET });
    await h.store.create(reminderInput());
    await h.store.writeStatus('Grok Bot');
    h.pusher.notify();
    await h.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS, () => h.pusher.idle());
    await h.store.writeStatus('Grok Bot');
    h.pusher.notify();
    await h.clock.advanceTo(h.clock.now() + STATUS_PUSH_DEBOUNCE_MS, () => h.pusher.idle());
    expect(h.posts).toHaveLength(2);
    const first = JSON.parse(h.posts[0]!.body) as { updatedAt: number; items: unknown };
    const second = JSON.parse(h.posts[1]!.body) as { updatedAt: number; items: unknown };
    expect(second.items).toEqual(first.items);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);

    const dir = join(h.store.getFilePath(), '..');
    const posts: Array<{ body: string }> = [];
    const reloaded = new AutomationsStore({
      path: join(dir, 'automations.json'),
      logPath: join(dir, 'automations.log'),
      statusPath: join(dir, 'automations-status.json'),
      now: () => first.updatedAt,
    });
    await reloaded.load();
    await reloaded.writeStatus('Grok Bot');
    const pusher = createStatusPusher({
      endpoint: ENDPOINT,
      secret: SECRET,
      profile: PROFILE,
      store: reloaded,
      now: () => first.updatedAt,
      setTimeout: (fn) => {
        fn();
        return 1;
      },
      clearTimeout: () => {},
      fetch: (async (_input: string | URL, init?: RequestInit) => {
        posts.push({ body: String(init?.body ?? '') });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    pushers.push(pusher);
    pusher.notify();
    await pusher.idle();
    const third = JSON.parse(posts[0]!.body) as { updatedAt: number; items: unknown };
    expect(third.items).toEqual(first.items);
    expect(third.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('retries 5xx and network errors with capped backoff, then full-syncs on the next notify', async () => {
    const h = await harness({ endpoint: ENDPOINT, secret: SECRET });
    await h.store.create(reminderInput());
    await h.store.writeStatus('Grok Bot');
    let calls = 0;
    h.fetchImpl.mockImplementation(async (input, init) => {
      calls += 1;
      h.posts.push({
        url: String(input),
        headers: headersOf(init?.headers),
        body: String(init?.body ?? ''),
      });
      if (calls === 1) return new Response(null, { status: 503 });
      if (calls === 2) throw new Error('network down');
      return new Response(null, { status: 204 });
    });
    h.pusher.notify();
    await h.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS, () => h.pusher.idle());
    expect(h.posts).toHaveLength(1);
    await h.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS + STATUS_PUSH_RETRY_MIN_MS, () => h.pusher.idle());
    expect(h.posts).toHaveLength(2);
    await h.clock.advanceTo(
      NOW + STATUS_PUSH_DEBOUNCE_MS + STATUS_PUSH_RETRY_MIN_MS + 2 * STATUS_PUSH_RETRY_MIN_MS,
      () => h.pusher.idle(),
    );
    expect(h.posts).toHaveLength(3);
    expect(STATUS_PUSH_RETRY_MAX_MS).toBe(60_000);

    h.posts.length = 0;
    await h.store.writeStatus('Grok Bot');
    h.pusher.notify();
    await h.clock.advanceTo(h.clock.now() + STATUS_PUSH_DEBOUNCE_MS, () => h.pusher.idle());
    expect(h.posts).toHaveLength(1);
    expect(JSON.parse(h.posts[0]!.body)).toMatchObject({ v: 2 });
  });

  it('retries 408 and 429, honours Retry-After under the cap, and leaves other 4xx terminal', async () => {
    const h = await harness({ endpoint: ENDPOINT, secret: SECRET });
    await h.store.create(reminderInput());
    await h.store.writeStatus('Grok Bot');
    let calls = 0;
    h.fetchImpl.mockImplementation(async (input, init) => {
      calls += 1;
      h.posts.push({
        url: String(input),
        headers: headersOf(init?.headers),
        body: String(init?.body ?? ''),
      });
      if (calls === 1) return new Response(null, { status: 408 });
      if (calls === 2) {
        return new Response(null, { status: 429, headers: { 'Retry-After': '12' } });
      }
      return new Response(null, { status: 204 });
    });
    h.pusher.notify();
    await h.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS, () => h.pusher.idle());
    expect(h.posts).toHaveLength(1);
    await h.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS + STATUS_PUSH_RETRY_MIN_MS, () => h.pusher.idle());
    expect(h.posts).toHaveLength(2);
    await h.clock.advanceTo(
      NOW + STATUS_PUSH_DEBOUNCE_MS + STATUS_PUSH_RETRY_MIN_MS + STATUS_PUSH_RETRY_MIN_MS,
      () => h.pusher.idle(),
    );
    expect(h.posts).toHaveLength(2);
    await h.clock.advanceTo(
      NOW + STATUS_PUSH_DEBOUNCE_MS + STATUS_PUSH_RETRY_MIN_MS + 12_000,
      () => h.pusher.idle(),
    );
    expect(h.posts).toHaveLength(3);

    const terminal = await harness({ endpoint: ENDPOINT, secret: SECRET });
    await terminal.store.create(reminderInput());
    await terminal.store.writeStatus('Grok Bot');
    terminal.fetchImpl.mockImplementation(async (input, init) => {
      terminal.posts.push({
        url: String(input),
        headers: headersOf(init?.headers),
        body: String(init?.body ?? ''),
      });
      return new Response(null, { status: 404 });
    });
    terminal.pusher.notify();
    await terminal.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS, () => terminal.pusher.idle());
    expect(terminal.posts).toHaveLength(1);
    await terminal.clock.advanceTo(
      NOW + STATUS_PUSH_DEBOUNCE_MS + STATUS_PUSH_RETRY_MAX_MS + 1,
      () => terminal.pusher.idle(),
    );
    expect(terminal.posts).toHaveLength(1);

    const capped = await harness({ endpoint: ENDPOINT, secret: SECRET });
    await capped.store.create(reminderInput());
    await capped.store.writeStatus('Grok Bot');
    let cappedCalls = 0;
    capped.fetchImpl.mockImplementation(async (input, init) => {
      cappedCalls += 1;
      capped.posts.push({
        url: String(input),
        headers: headersOf(init?.headers),
        body: String(init?.body ?? ''),
      });
      if (cappedCalls === 1) {
        return new Response(null, { status: 429, headers: { 'Retry-After': '120' } });
      }
      return new Response(null, { status: 204 });
    });
    capped.pusher.notify();
    await capped.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS, () => capped.pusher.idle());
    expect(capped.posts).toHaveLength(1);
    await capped.clock.advanceTo(
      NOW + STATUS_PUSH_DEBOUNCE_MS + STATUS_PUSH_RETRY_MAX_MS,
      () => capped.pusher.idle(),
    );
    expect(capped.posts).toHaveLength(2);
  });

  it('aborts a hung status POST after a few seconds and retries, and stop does not wait on it', async () => {
    expect(STATUS_PUSH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STATUS_PUSH_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    const h = await harness({ endpoint: ENDPOINT, secret: SECRET });
    await h.store.create(reminderInput());
    await h.store.writeStatus('Grok Bot');
    let calls = 0;
    const signals: AbortSignal[] = [];
    h.fetchImpl.mockImplementation((_input, init) => {
      calls += 1;
      const signal = init?.signal;
      if (signal) signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return;
        const onAbort = () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    });
    h.pusher.notify();
    await h.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS, () => Promise.resolve());
    await waitFor(() => calls === 1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    await h.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS + STATUS_PUSH_TIMEOUT_MS, () => h.pusher.idle());
    expect(signals[0]?.aborted).toBe(true);
    await h.clock.advanceTo(
      NOW + STATUS_PUSH_DEBOUNCE_MS + STATUS_PUSH_TIMEOUT_MS + STATUS_PUSH_RETRY_MIN_MS,
      () => Promise.resolve(),
    );
    await waitFor(() => calls === 2);
    h.pusher.stop();

    const hung = await harness({ endpoint: ENDPOINT, secret: SECRET });
    await hung.store.create(reminderInput());
    await hung.store.writeStatus('Grok Bot');
    hung.fetchImpl.mockImplementation(() => new Promise<Response>(() => {}));
    hung.pusher.notify();
    await hung.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS, () => Promise.resolve());
    await waitFor(() => hung.fetchImpl.mock.calls.length === 1);
    hung.pusher.stop();
    await Promise.race([
      hung.pusher.idle(),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('idle hung after stop')), 200);
      }),
    ]);
  });

  it('logs a push failure without the secret', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    try {
      const h = await harness({ endpoint: ENDPOINT, secret: SECRET });
      await h.store.create(reminderInput());
      await h.store.writeStatus('Grok Bot');
      h.fetchImpl.mockRejectedValue(new Error('network down'));
      h.pusher.notify();
      await h.clock.advanceTo(NOW + STATUS_PUSH_DEBOUNCE_MS, () => h.pusher.idle());
      const dumped = JSON.stringify(fail.mock.calls);
      expect(dumped).toContain('status-push');
      expect(dumped).not.toContain(SECRET);
      expect(dumped).not.toMatch(/unit-status-secret/);
    } finally {
      fail.mockRestore();
    }
  });
});
