import { log } from '../core/logger';
import {
  STATUS_PUSH_DEBOUNCE_MS,
  STATUS_PUSH_RETRY_MAX_MS,
  STATUS_PUSH_RETRY_MIN_MS,
  STATUS_PUSH_SIGNATURE_HEADER,
  STATUS_PUSH_TIMEOUT_MS,
  STATUS_PUSH_TIMESTAMP_HEADER,
  buildStatusPushPayload,
  signStatusPush,
} from './status-push';
import type { AutomationsStore } from './store';

export interface StatusPusher {
  notify(): void;
  stop(): void;
  idle(): Promise<void>;
}

export interface StatusPusherDeps {
  endpoint?: string;
  secret?: string;
  profile: string;
  store: AutomationsStore;
  now?: () => number;
  setTimeout?: (fn: () => void, delayMs: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  fetch?: typeof fetch;
}

export function createStatusPusher(deps: StatusPusherDeps): StatusPusher {
  return new Pusher(deps);
}

class Pusher implements StatusPusher {
  private readonly endpoint: string | undefined;
  private readonly secret: string | undefined;
  private readonly profile: string;
  private readonly store: AutomationsStore;
  private readonly now: () => number;
  private readonly setTimeout: (fn: () => void, delayMs: number) => unknown;
  private readonly clearTimeout: (id: unknown) => void;
  private readonly fetch: typeof fetch;
  private debounceTimer: unknown;
  private retryTimer: unknown;
  private failCount = 0;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  private inflightAbort: AbortController | undefined;

  constructor(deps: StatusPusherDeps) {
    this.endpoint = trimmed(deps.endpoint);
    this.secret = trimmed(deps.secret);
    this.profile = deps.profile;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.setTimeout = deps.setTimeout ?? ((fn, delayMs) => setTimeout(fn, delayMs));
    this.clearTimeout = deps.clearTimeout ?? ((id) => clearTimeout(id as NodeJS.Timeout));
    this.fetch = deps.fetch ?? fetch;
  }

  notify(): void {
    if (this.closed || !this.endpoint || !this.secret) return;
    this.clearRetry();
    this.failCount = 0;
    this.armDebounce();
  }

  stop(): void {
    this.closed = true;
    this.clearDebounce();
    this.clearRetry();
    this.inflightAbort?.abort();
  }

  idle(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.chain;
  }

  private armDebounce(): void {
    this.clearDebounce();
    this.debounceTimer = this.setTimeout(() => {
      this.debounceTimer = undefined;
      this.enqueue(() => this.post());
    }, STATUS_PUSH_DEBOUNCE_MS);
  }

  private scheduleRetry(retryAfterMs?: number): void {
    if (this.closed || !this.endpoint || !this.secret) return;
    this.clearRetry();
    const backoff = Math.min(
      STATUS_PUSH_RETRY_MAX_MS,
      STATUS_PUSH_RETRY_MIN_MS * (2 ** this.failCount),
    );
    const delay = Math.min(
      STATUS_PUSH_RETRY_MAX_MS,
      Math.max(backoff, retryAfterMs ?? 0),
    );
    this.failCount += 1;
    this.retryTimer = this.setTimeout(() => {
      this.retryTimer = undefined;
      this.enqueue(() => this.post());
    }, delay);
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn, fn).then(
      () => {},
      (error) => {
        log.fail('auto', error, { event: 'status-push' });
      },
    );
  }

  private async post(): Promise<void> {
    const endpoint = this.endpoint;
    const secret = this.secret;
    if (this.closed || !endpoint || !secret) return;
    const abort = new AbortController();
    this.inflightAbort = abort;
    let timeout: unknown;
    try {
      const snapshot = await this.store.readStatus();
      if (this.closed) return;
      const payload = buildStatusPushPayload({
        secret,
        profile: this.profile,
        updatedAt: snapshot?.updatedAt ?? this.now(),
        now: this.now(),
        items: this.store.list(),
      });
      const body = JSON.stringify(payload);
      const timestamp = String(this.now());
      const url = `${endpoint.replace(/\/+$/, '')}/v1/status`;
      timeout = this.setTimeout(() => abort.abort(), STATUS_PUSH_TIMEOUT_MS);
      const response = await this.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [STATUS_PUSH_TIMESTAMP_HEADER]: timestamp,
          [STATUS_PUSH_SIGNATURE_HEADER]: signStatusPush(secret, timestamp, body),
        },
        body,
        signal: abort.signal,
      });
      if (this.closed) return;
      if (response.ok) {
        this.failCount = 0;
        return;
      }
      log.fail('auto', new Error(`HTTP ${response.status}`), {
        event: 'status-push',
        status: response.status,
      });
      if (isRetryableStatus(response.status)) {
        this.scheduleRetry(retryAfterMs(response));
      }
    } catch (error) {
      if (this.closed) return;
      log.fail('auto', error, { event: 'status-push' });
      this.scheduleRetry();
    } finally {
      if (timeout !== undefined) this.clearTimeout(timeout);
      if (this.inflightAbort === abort) this.inflightAbort = undefined;
    }
  }

  private clearDebounce(): void {
    if (this.debounceTimer === undefined) return;
    this.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return;
    this.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function trimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const next = value.trim();
  return next ? next : undefined;
}
