import type { LarkChannel } from '@larksuite/channel';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../core/logger';
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

export interface FeishuLinkDeps {
  channel: LarkChannel;
  probe: () => Promise<boolean>;
  watermark: { get(): number | undefined; set(at: number): void };
  now?: () => number;
  /** Awake event-loop time. Defaults to `performance.now`. */
  monotonic?: () => number;
  heartbeatPath?: string;
  outbound?: OutboundMessageIds;
  outboundTimeoutMs?: number;
}

export function createFeishuProbe(channel: LarkChannel): () => Promise<boolean> {
  return async () => {
    try {
      await channel.getAppInfo();
      return true;
    } catch (err) {
      // A 4xx means Feishu answered; credentials/quota are not a link outage.
      return isBusiness4xx(err);
    }
  };
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: { status?: unknown } }).response;
  const status = response?.status;
  return typeof status === 'number' ? status : undefined;
}

export function isBusiness4xx(error: unknown): boolean {
  const status = httpStatus(error);
  return status !== undefined && status >= 400 && status < 500;
}

async function raceProbe(
  probe: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe().catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
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
    let ok = false;
    try {
      ok = await raceProbe(deps.probe, FEISHU_LINK_PROBE_TIMEOUT_MS);
    } catch {
      ok = false;
    } finally {
      if (seq !== probeSeq) return;
      probing = false;
      const suspended = noteSleepIfProbeSuspended();
      // Record sleep before moving the baseline. Resetting first would hide
      // a Windows standby gap where wall-minus-mono is ~0.
      if (!suspended) lastTickAt = nowFn();
    }
    if (seq !== probeSeq || stopped) return;
    if (ok) {
      noteEvidence(nowFn(), wsConnected());
      lastTickAt = nowFn();
      return;
    }
    goDown(lastEvidenceAt ?? downSince);
    lastTickAt = nowFn();
  };

  wrapChannelOutbound(deps.channel, deps.outbound ?? new OutboundMessageIds(), {
    ...(deps.outboundTimeoutMs !== undefined ? { timeoutMs: deps.outboundTimeoutMs } : {}),
    onResult: (result) => {
      if (stopped) return;
      if (!result.ok && !isBusiness4xx(result.error)) {
        goDown(lastEvidenceAt ?? downSince);
        return;
      }
      noteEvidence(nowFn(), wsConnected());
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
      clearInterval(timer);
    },
    tick,
  };
}
