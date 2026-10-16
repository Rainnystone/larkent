import type { LarkChannel } from '@larksuite/channel';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../core/logger';
import { classify } from './feishu-error';
import { OutboundMessageIds, wrapChannelOutbound } from './self-message';

export const FEISHU_LINK_TICK_MS = 15_000;
export const FEISHU_LINK_SLEEP_MS = 30_000;
export const FEISHU_LINK_SILENT_PROBE_MS = 60_000;
/** Must stay below `FEISHU_LINK_SLEEP_MS` so a hung probe cannot look like suspend. */
export const FEISHU_LINK_PROBE_TIMEOUT_MS = 20_000;
const TIMER_STORM_GUARD_MS = 5_000;
const WS_DOWN_LOG_EVERY = 20;

export interface Outage {
  since: number;
  until: number;
}

export interface FeishuLink {
  isDown(): boolean;
  outageEpoch(): number;
  onRecovered(fn: (o: Outage) => void): () => void;
  noteInbound(at?: number): void;
  stop(): void;
}

/** true = reachable; false = link down; `unknown` = local, neither evidence nor outage. */
export type FeishuProbeResult = boolean | 'unknown';

export interface FeishuLinkDeps {
  channel: LarkChannel;
  probe: (signal?: AbortSignal) => Promise<FeishuProbeResult>;
  watermark: { get(): number | undefined; set(at: number): void };
  now?: () => number;
  /** Awake event-loop time. Defaults to `performance.now`. */
  monotonic?: () => number;
  heartbeatPath?: string;
  outbound?: OutboundMessageIds;
  outboundTimeoutMs?: number;
}

export function createFeishuProbe(
  channel: LarkChannel,
): (signal?: AbortSignal) => Promise<FeishuProbeResult> {
  return async (signal) => {
    if (signal?.aborted) return false;
    try {
      await settleOrAbort(channel.getAppInfo(), signal);
      return !signal?.aborted;
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) return false;
      return probeResultFromError(err);
    }
  };
}

function settleOrAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort);
    work.then(
      (value) => {
        cleanup();
        if (signal.aborted) reject(abortError());
        else resolve(value);
      },
      (err: unknown) => {
        cleanup();
        reject(err);
      },
    );
  });
}

function abortError(): Error {
  const err = new Error('probe aborted');
  err.name = 'AbortError';
  return err;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function probeResultFromError(err: unknown): FeishuProbeResult {
  const kind = classify(err);
  switch (kind) {
    case 'rejected':
      return true;
    case 'link':
      return false;
    case 'local':
      return 'unknown';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

async function raceProbe(
  probe: (signal?: AbortSignal) => Promise<FeishuProbeResult>,
  timeoutMs: number,
  ctrl: AbortController,
): Promise<FeishuProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe(ctrl.signal)
        .then((ok) => (ctrl.signal.aborted ? false : ok))
        .catch((err: unknown) => (ctrl.signal.aborted || isAbortError(err) ? false : probeResultFromError(err))),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          ctrl.abort();
          resolve(false);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function startFeishuLink(deps: FeishuLinkDeps): FeishuLink & { tick(): Promise<void> } {
  const nowFn = deps.now ?? Date.now;
  const monoFn = deps.monotonic ?? (() => performance.now());
  const listeners = new Set<(o: Outage) => void>();
  let stopped = false;
  let down = true;
  let epoch = 0;
  let downSince = deps.watermark.get() ?? nowFn();
  let lastTickAt = 0;
  let lastEvidenceAt: number | undefined;
  let probing = false;
  let probeSeq = 0;
  let probeAbort: AbortController | undefined;
  let probeWallStart = 0;
  let probeMonoStart = 0;
  let wsDownTicks = 0;

  const touchHeartbeat = (): void => {
    if (!deps.heartbeatPath) return;
    try {
      mkdirSync(dirname(deps.heartbeatPath), { recursive: true });
      writeFileSync(deps.heartbeatPath, `${Date.now()}\n`);
    } catch (err) {
      log.fail('link', err, { step: 'heartbeat' });
    }
  };

  const emitRecovered = (outage: Outage): void => {
    for (const listener of listeners) listener(outage);
  };

  const goDown = (since: number): void => {
    if (down) {
      downSince = Math.min(downSince, since);
      return;
    }
    down = true;
    epoch += 1;
    downSince = since;
  };

  const goUp = (until: number): void => {
    if (!down) return;
    down = false;
    lastEvidenceAt = until;
    deps.watermark.set(until);
    const outage = { since: downSince, until };
    log.info('link', 'recovered', outage);
    emitRecovered(outage);
  };

  const noteEvidence = (at: number, wsConnected: boolean): void => {
    lastEvidenceAt = at;
    if (down) {
      if (wsConnected) goUp(at);
      return;
    }
    deps.watermark.set(at);
  };

  const wsConnected = (): boolean => deps.channel.getConnectionStatus()?.state === 'connected';

  const probeWallElapsedMs = (): number => Math.max(0, nowFn() - probeWallStart);

  const noteSleepIfProbeSuspended = (): boolean => {
    // Wall elapsed covers Windows QPC (monotonic includes standby, so
    // wall-minus-mono is ~0). Do not move lastTickAt until after goDown.
    const wallElapsed = probeWallElapsedMs();
    const monoElapsed = Math.max(0, monoFn() - probeMonoStart);
    if (wallElapsed <= FEISHU_LINK_SLEEP_MS) return false;
    log.info('link', 'sleep', { sleptMs: wallElapsed, monoElapsed });
    goDown(probeWallStart);
    return true;
  };

  const tick = async (fromTimer = false): Promise<void> => {
    if (stopped) return;
    const now = nowFn();
    if (probing) {
      // Do not move lastTickAt while the probe is still in flight.
      if (noteSleepIfProbeSuspended()) return;
      if (probeWallElapsedMs() > FEISHU_LINK_PROBE_TIMEOUT_MS) {
        probeAbort?.abort();
        probeSeq += 1;
        probing = false;
        goDown(lastEvidenceAt ?? downSince);
        lastTickAt = nowFn();
      }
      return;
    }
    const sinceLast = lastTickAt > 0 ? now - lastTickAt : 0;
    // Storm guard is for stacked interval callbacks after a freeze, not for
    // explicit ticks (SDK reconnecting/reconnected can fire milliseconds apart).
    if (fromTimer && sinceLast > 0 && sinceLast < TIMER_STORM_GUARD_MS) return;
    touchHeartbeat();

    if (sinceLast > FEISHU_LINK_SLEEP_MS) {
      log.info('link', 'sleep', { sleptMs: sinceLast });
      goDown(lastTickAt);
    }
    lastTickAt = now;

    const status = deps.channel.getConnectionStatus();
    const connected = status?.state === 'connected';
    if (!connected) {
      goDown(lastEvidenceAt ?? downSince);
      wsDownTicks += 1;
      const state = status?.state ?? 'unknown';
      if (wsDownTicks === 1 || wsDownTicks % WS_DOWN_LOG_EVERY === 0) {
        if (state === 'failed') {
          log.warn('link', 'unrecoverable', { state, wsDownTicks });
        } else {
          log.warn('link', 'ws-down', { state, wsDownTicks });
        }
      }
    } else {
      wsDownTicks = 0;
    }

    const silentMs = lastEvidenceAt === undefined ? Number.POSITIVE_INFINITY : now - lastEvidenceAt;
    const shouldProbe = down || silentMs >= FEISHU_LINK_SILENT_PROBE_MS;
    if (!shouldProbe) return;

    const seq = ++probeSeq;
    probing = true;
    probeWallStart = now;
    probeMonoStart = monoFn();
    const ctrl = new AbortController();
    probeAbort = ctrl;
    let ok: FeishuProbeResult = false;
    try {
      ok = await raceProbe(deps.probe, FEISHU_LINK_PROBE_TIMEOUT_MS, ctrl);
    } catch (err) {
      ok = probeResultFromError(err);
    } finally {
      if (probeAbort === ctrl) probeAbort = undefined;
      if (seq !== probeSeq) return;
      probing = false;
      const suspended = noteSleepIfProbeSuspended();
      // Record sleep before moving the baseline. Resetting first would hide
      // a Windows standby gap where wall-minus-mono is ~0.
      if (!suspended) lastTickAt = nowFn();
    }
    if (seq !== probeSeq || stopped) return;
    switch (ok) {
      case true:
        noteEvidence(nowFn(), wsConnected());
        lastTickAt = nowFn();
        return;
      case false:
        goDown(lastEvidenceAt ?? downSince);
        lastTickAt = nowFn();
        return;
      case 'unknown':
        lastTickAt = nowFn();
        return;
      default: {
        const _exhaustive: never = ok;
        return _exhaustive;
      }
    }
  };

  wrapChannelOutbound(deps.channel, deps.outbound ?? new OutboundMessageIds(), {
    ...(deps.outboundTimeoutMs !== undefined ? { timeoutMs: deps.outboundTimeoutMs } : {}),
    onResult: (result) => {
      if (stopped) return;
      if (result.ok) {
        noteEvidence(nowFn(), wsConnected());
        return;
      }
      const kind = classify(result.error);
      switch (kind) {
        case 'link':
          goDown(lastEvidenceAt ?? downSince);
          return;
        case 'rejected':
          noteEvidence(nowFn(), wsConnected());
          return;
        case 'local':
          return;
        default: {
          const _exhaustive: never = kind;
          return _exhaustive;
        }
      }
    },
  });

  const timer = setInterval(() => {
    void tick(true).catch((err) => log.fail('link', err, { step: 'tick' }));
  }, FEISHU_LINK_TICK_MS);
  timer.unref?.();

  return {
    isDown: () => down,
    outageEpoch: () => epoch,
    onRecovered(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    noteInbound(at) {
      if (stopped) return;
      noteEvidence(at ?? nowFn(), true);
    },
    stop() {
      stopped = true;
      probeAbort?.abort();
      clearInterval(timer);
    },
    tick,
  };
}
