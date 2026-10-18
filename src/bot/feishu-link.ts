import type { LarkChannel } from '@larksuite/channel';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../core/logger';
import {
  createHostSleepProbe,
  HOST_SLEEP_PROBE_TIMEOUT_MS,
  type HostSleepEvidence,
  type HostSleepProbe,
} from '../platform/host-sleep';
import { classify } from './feishu-error';
import { OutboundMessageIds, wrapChannelOutbound } from './self-message';

export const FEISHU_LINK_TICK_MS = 15_000;
/** Wall-clock gap that still takes the link down. Not itself suspend evidence. */
export const FEISHU_LINK_SLEEP_MS = 30_000;
export const FEISHU_LINK_SILENT_PROBE_MS = 60_000;
/** Must stay below `FEISHU_LINK_SLEEP_MS` so a hung Feishu probe cannot look like a tick gap. */
export const FEISHU_LINK_PROBE_TIMEOUT_MS = 20_000;
const TIMER_STORM_GUARD_MS = 5_000;
const WS_DOWN_LOG_EVERY = 20;

export interface Outage {
  since: number;
  until: number;
  /** True only with real OS sleep evidence inside the outage. Freeze is not sleep. */
  hostSuspended: boolean;
  /** Last local tick before a host-suspend gap. Review uses this, not `since`. */
  suspendStartedAt?: number;
}

export interface FeishuLink {
  isDown(): boolean;
  outageEpoch(): number;
  onRecovered(fn: (o: Outage) => void): () => void;
  noteInbound(at?: number): void;
  /** Pong or any other frame on the current socket. Ignored unless a wake reconnect is open. */
  noteSocketFrame(at?: number): void;
  /** SDK keepalive noticed a suspend gap. Forces the same reconnect as a tick gap. */
  noteKeepaliveWake(at?: number): void;
  stop(): void;
}

/** true = reachable; false = link down; `unknown` = local, neither evidence nor outage. */
export type FeishuProbeResult = boolean | 'unknown';

export interface FeishuLinkDeps {
  channel: LarkChannel;
  probe: (signal?: AbortSignal) => Promise<FeishuProbeResult>;
  watermark: {
    get(): number | undefined;
    set(at: number): void;
    /** Persist the outage origin before `set` advances lastLiveAt. */
    holdOutage?(since: number): void;
  };
  now?: () => number;
  heartbeatPath?: string;
  outbound?: OutboundMessageIds;
  outboundTimeoutMs?: number;
  sleepProbe?: HostSleepProbe;
  /** Force a new WebSocket after a tick gap or keepalive wake-up. */
  reconnect?: () => void | Promise<void>;
}

export function createFeishuProbe(
  channel: LarkChannel,
): (signal?: AbortSignal) => Promise<FeishuProbeResult> {
  // Capture before wrapChannelOutbound so a late REST success after probe
  // abort cannot take the link up through the outbound onResult classifier.
  const getAppInfo = channel.getAppInfo.bind(channel);
  return async (signal) => {
    if (signal?.aborted) return false;
    try {
      await settleOrAbort(getAppInfo(), signal);
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

function isThenable(value: void | Promise<void>): value is Promise<void> {
  return typeof (value as Promise<void> | null | undefined)?.then === 'function';
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
  const sleepProbe = deps.sleepProbe ?? createHostSleepProbe();
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
  let hostSuspended = false;
  let suspendStartedAt: number | undefined;
  let sleepDetect: Promise<void> | undefined;
  let wsDownTicks = 0;
  /** Set on a tick gap until a frame arrives on the socket opened after it. */
  let awaitingFreshInbound = false;
  let lastWakeArmAt = 0;
  /** Bumped each time a wake reconnect is armed. A frame or open from an older wake does not count. */
  let wakeEpoch = 0;
  let openedEpoch = 0;
  let frameEpoch = 0;
  /** Wake reconnect rejected. A frame counts only after the socket has been down and is connected again. */
  let wakeFailed = false;
  let sawSocketDown = false;
  /** Last outage handed to recovery. A late sleep result merges into this window. */
  let lastRecovered: Outage | undefined;

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

  const goDown = (since: number, opts?: { hostSuspended?: boolean; suspendStartedAt?: number }): void => {
    if (opts?.hostSuspended) {
      hostSuspended = true;
      if (opts.suspendStartedAt !== undefined) {
        suspendStartedAt = suspendStartedAt === undefined
          ? opts.suspendStartedAt
          : Math.min(suspendStartedAt, opts.suspendStartedAt);
      }
    }
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
    deps.watermark.holdOutage?.(downSince);
    deps.watermark.set(until);
    const outage: Outage = {
      since: downSince,
      until,
      hostSuspended,
      ...(hostSuspended && suspendStartedAt !== undefined ? { suspendStartedAt } : {}),
    };
    hostSuspended = false;
    suspendStartedAt = undefined;
    log.info('link', 'recovered', {
      since: outage.since,
      until: outage.until,
      hostSuspended: outage.hostSuspended,
      ...(outage.suspendStartedAt !== undefined ? { suspendStartedAt: outage.suspendStartedAt } : {}),
    });
    lastRecovered = outage;
    emitRecovered(outage);
  };

  const publishSuspend = (
    gapFrom: number,
    gapTo: number,
    evidence: HostSleepEvidence,
    sleptMs: number,
  ): void => {
    if (!evidence.suspended || stopped) return;
    const startedAt = evidence.suspendStartedAt ?? gapFrom;
    log.info('link', 'sleep', {
      sleptMs,
      ...(evidence.suspendStartedAt !== undefined ? { suspendStartedAt: evidence.suspendStartedAt } : {}),
    });
    if (down) {
      goDown(gapFrom, { hostSuspended: true, suspendStartedAt: startedAt });
      return;
    }
    if (lastRecovered?.hostSuspended) return;
    const since = lastRecovered ? Math.min(lastRecovered.since, gapFrom) : gapFrom;
    const until = lastRecovered ? Math.max(lastRecovered.until, gapTo) : gapTo;
    const amended: Outage = {
      since,
      until,
      hostSuspended: true,
      suspendStartedAt: startedAt,
    };
    lastRecovered = amended;
    log.info('link', 'recovered', {
      since: amended.since,
      until: amended.until,
      hostSuspended: true,
      suspendStartedAt: startedAt,
    });
    emitRecovered(amended);
  };

  const noteEvidence = (at: number, wsConnected: boolean): void => {
    lastEvidenceAt = at;
    if (down) {
      if (wsConnected && !awaitingFreshInbound) goUp(at);
      return;
    }
    deps.watermark.set(at);
  };

  const recentlyArmed = (at: number): boolean =>
    lastWakeArmAt > 0 && at - lastWakeArmAt < FEISHU_LINK_SLEEP_MS;

  const wsConnected = (): boolean => deps.channel.getConnectionStatus()?.state === 'connected';

  const maybeFinishWake = (at: number): void => {
    if (stopped || !awaitingFreshInbound) return;
    if (openedEpoch !== wakeEpoch || frameEpoch !== wakeEpoch) return;
    if (!wsConnected()) return;
    awaitingFreshInbound = false;
    noteEvidence(at, true);
  };

  const armWakeReconnect = (at: number, gapMs: number): void => {
    if (recentlyArmed(at)) return;
    lastWakeArmAt = at;
    awaitingFreshInbound = true;
    wakeFailed = false;
    sawSocketDown = false;
    wakeEpoch += 1;
    const epoch = wakeEpoch;
    const markOpened = (): void => {
      if (stopped || epoch !== wakeEpoch) return;
      openedEpoch = epoch;
      maybeFinishWake(nowFn());
    };
    if (!deps.reconnect) {
      markOpened();
      return;
    }
    log.info('link', 'wake-reconnect', { gapMs });
    let result: void | Promise<void>;
    try {
      result = deps.reconnect();
    } catch (err) {
      log.fail('link', err, { step: 'wake-reconnect' });
      wakeFailed = true;
      frameEpoch = 0;
      return;
    }
    if (isThenable(result)) {
      void result.then(markOpened, (err: unknown) => {
        log.fail('link', err, { step: 'wake-reconnect' });
        if (stopped || epoch !== wakeEpoch) return;
        wakeFailed = true;
        frameEpoch = 0;
      });
      return;
    }
    markOpened();
  };

  const noteSocketPresence = (connected: boolean): void => {
    if (!awaitingFreshInbound) return;
    if (!connected) {
      sawSocketDown = true;
      return;
    }
    if (wakeFailed && sawSocketDown && openedEpoch !== wakeEpoch) {
      openedEpoch = wakeEpoch;
    }
  };

  const noteSuspendIfGap = (at: number): void => {
    const sinceLast = lastTickAt > 0 ? at - lastTickAt : 0;
    if (lastTickAt > 0 && sinceLast > FEISHU_LINK_SLEEP_MS) {
      log.info('link', 'tick-gap', { gapMs: sinceLast });
      const sameWake = recentlyArmed(at);
      // A frame on the new socket can finish this wake before the interval
      // tick. Still record the suspend; do not take the link down again.
      const wakeAlreadyRecovered = sameWake && !awaitingFreshInbound;
      if (!wakeAlreadyRecovered) {
        goDown(lastTickAt);
        probeSeq += 1;
        probing = false;
        probeAbort?.abort();
      }
      const gapFrom = lastTickAt;
      const gapTo = at;
      sleepDetect = detectSleep(sleepProbe, { fromMs: gapFrom, toMs: gapTo }).then((evidence) => {
        publishSuspend(gapFrom, gapTo, evidence, sinceLast);
      });
      if (!sameWake) armWakeReconnect(at, sinceLast);
    }
    void Promise.resolve()
      .then(() => sleepProbe.note(at))
      .catch(() => {
        /* OS sample is best-effort */
      });
  };

  const applySleepEvidence = async (): Promise<void> => {
    const pending = sleepDetect;
    if (!pending) return;
    sleepDetect = undefined;
    try {
      await pending;
    } catch {
      /* timeout/failure = not suspended; never block recovery */
    }
  };

  const tick = async (fromTimer = false): Promise<void> => {
    if (stopped) return;
    const now = nowFn();
    const sinceLast = lastTickAt > 0 ? now - lastTickAt : 0;
    // Storm guard is for stacked interval callbacks after a freeze, not for
    // explicit ticks (SDK reconnecting/reconnected can fire milliseconds apart).
    if (fromTimer && sinceLast > 0 && sinceLast < TIMER_STORM_GUARD_MS) return;
    touchHeartbeat();

    noteSuspendIfGap(now);
    lastTickAt = now;

    const status = deps.channel.getConnectionStatus();
    const connected = status?.state === 'connected';
    noteSocketPresence(connected);
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
    if (!shouldProbe || probing) {
      if (!probing) await applySleepEvidence();
      return;
    }

    const seq = ++probeSeq;
    probing = true;
    const ctrl = new AbortController();
    probeAbort = ctrl;
    let ok: FeishuProbeResult = false;
    try {
      ok = await raceProbe(deps.probe, FEISHU_LINK_PROBE_TIMEOUT_MS, ctrl);
    } catch (err) {
      ok = probeResultFromError(err);
    } finally {
      if (probeAbort === ctrl) probeAbort = undefined;
      const after = nowFn();
      // A freeze can resume the probe timer before the next interval tick.
      // Detect the gap here so lastTickAt is not stamped over the suspend.
      noteSuspendIfGap(after);
      lastTickAt = after;
      if (seq !== probeSeq) return;
      probing = false;
    }
    await applySleepEvidence();
    if (seq !== probeSeq || stopped) return;
    switch (ok) {
      case true:
        noteEvidence(nowFn(), wsConnected());
        maybeFinishWake(nowFn());
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
    ...(deps.outboundTimeoutMs !== undefined ? {
      timeoutMs: deps.outboundTimeoutMs,
      producerTimeoutMs: deps.outboundTimeoutMs,
    } : {}),
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
      const stamp = at ?? nowFn();
      if (!awaitingFreshInbound) {
        noteEvidence(stamp, wsConnected());
        return;
      }
      // A message handler can still be the socket we are replacing.
      if (openedEpoch !== wakeEpoch || !wsConnected()) return;
      frameEpoch = wakeEpoch;
      maybeFinishWake(stamp);
    },
    noteSocketFrame(at) {
      if (stopped || !awaitingFreshInbound) return;
      if (wakeFailed && openedEpoch !== wakeEpoch && !wsConnected()) return;
      frameEpoch = wakeEpoch;
      maybeFinishWake(at ?? nowFn());
    },
    noteKeepaliveWake(at) {
      if (stopped) return;
      const stamp = at ?? nowFn();
      if (recentlyArmed(stamp)) return;
      const sinceLast = lastTickAt > 0 ? stamp - lastTickAt : 0;
      goDown(lastTickAt > 0 ? lastTickAt : stamp);
      armWakeReconnect(stamp, sinceLast);
    },
    stop() {
      stopped = true;
      probeAbort?.abort();
      clearInterval(timer);
    },
    tick,
  };
}

async function detectSleep(
  probe: HostSleepProbe,
  gap: { fromMs: number; toMs: number },
): Promise<HostSleepEvidence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback: HostSleepEvidence = { suspended: false };
  const work = Promise.resolve()
    .then(() => probe.detect(gap))
    .then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    );
  try {
    const winner = await Promise.race([
      work,
      new Promise<{ ok: false }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), HOST_SLEEP_PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    return winner.ok ? winner.value : fallback;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
