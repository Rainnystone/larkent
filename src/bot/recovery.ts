import { resolveBackfillWindow } from './backfill';
import { log } from '../core/logger';
import type { Outage } from './feishu-link';

export type { Outage };

/** After recovery, a run silent since before `outage.since` may keep running this long. */
export const STALL_AFTER_RECOVERY_MS = 2 * 60_000;
export const RECOVERY_RETRY_MIN_MS = 1_000;
export const RECOVERY_RETRY_MAX_MS = 30_000;

export interface ReviewableRun {
  lastEventAt: number;
  interrupted: boolean;
  /** True while the stream processor has a tool call in flight. */
  hasOpenToolCall?: boolean;
  /** Pending stall delay when the stream processor has not installed a hook yet. */
  stallDeadlineMs?: number;
  /** Set once a stall deadline is armed; later reviews must not extend it. */
  stallArmedAt?: number;
  armStallDeadline?(delayMs: number): void;
}

export function reviewActiveRuns(runs: Iterable<ReviewableRun>, outage: Outage): void {
  const since = reviewSince(outage);
  for (const handle of runs) {
    if (handle.interrupted) continue;
    if (handle.lastEventAt >= since) continue;
    // Open tool calls keep the 60-minute cap unless the host actually slept.
    if (handle.hasOpenToolCall && !outage.hostSuspended) continue;
    // Keep the earliest absolute deadline. A later recovery retry must not
    // reset the idle timer back to a fresh 2 minutes.
    if (handle.stallArmedAt !== undefined) continue;
    handle.stallDeadlineMs = STALL_AFTER_RECOVERY_MS;
    handle.stallArmedAt = Date.now();
    handle.armStallDeadline?.(STALL_AFTER_RECOVERY_MS);
  }
}

function reviewSince(outage: Outage): number {
  if (outage.hostSuspended && outage.suspendStartedAt !== undefined) {
    return outage.suspendStartedAt;
  }
  return outage.since;
}

export interface RecoveryDeps {
  journal: { reapOrphans(): Promise<void>; redeliver(): Promise<void> };
  backfill: { scan(fromMs: number): Promise<boolean | void> };
  runs: { review(o: Outage): void };
  lookbackMs: () => number;
  now?: () => number;
  incompleteFrom?: () => number | undefined;
  /** Flush `incompleteFrom = outage.since` before reap/redeliver/backfill. */
  preserveOutage?: (since: number) => Promise<void>;
}

export interface Recovery {
  run(o: Outage): Promise<void>;
  stop(): Promise<void>;
}

type RecoveryStep = 'preserve' | 'reap' | 'redeliver' | 'backfill' | 'review';

export function createRecovery(deps: RecoveryDeps): Recovery {
  let inFlight: Promise<void> | undefined;
  let queued: Outage | undefined;
  let retry: Outage | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelayMs = RECOVERY_RETRY_MIN_MS;
  let stopped = false;
  let reviewedKey: string | undefined;

  const runStep = async (step: RecoveryStep, outage: Outage, work: () => Promise<void> | void): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (err) {
      log.fail('recovery', err, { step, since: outage.since, until: outage.until });
      return false;
    }
  };

  const runOnce = async (outage: Outage): Promise<boolean> => {
    const now = (deps.now ?? Date.now)();
    const lookbackMs = deps.lookbackMs();
    const window = resolveBackfillWindow({
      now,
      since: outage.since,
      incompleteFrom: deps.incompleteFrom?.(),
      lookbackMs,
    });
    if (outage.until - outage.since > lookbackMs) {
      log.info('backfill', 'window-truncated', {
        since: outage.since,
        until: outage.until,
        lookbackMs,
        windowStart: window.windowStart,
      });
    }
    if (deps.preserveOutage) {
      const preserved = await runStep('preserve', outage, () => deps.preserveOutage?.(outage.since));
      if (!preserved) return false;
    }
    if (stopped) return false;
    const reapOk = await runStep('reap', outage, () => deps.journal.reapOrphans());
    if (stopped) return false;
    const redeliverOk = await runStep('redeliver', outage, () => deps.journal.redeliver());
    if (stopped) return false;
    let backfillOk = false;
    try {
      const scanned = await deps.backfill.scan(window.windowStart);
      backfillOk = scanned !== false;
      if (!backfillOk) {
        log.fail('recovery', new Error('backfill incomplete'), {
          step: 'backfill',
          since: outage.since,
          until: outage.until,
        });
      }
    } catch (err) {
      log.fail('recovery', err, { step: 'backfill', since: outage.since, until: outage.until });
      backfillOk = false;
    }
    if (stopped) return false;
    const key = outageReviewKey(outage);
    let reviewOk = true;
    if (reviewedKey !== key) {
      reviewOk = await runStep('review', outage, () => {
        deps.runs.review(outage);
      });
      if (reviewOk) reviewedKey = key;
    }
    return reapOk && redeliverOk && backfillOk && reviewOk;
  };

  const clearRetryTimer = (): void => {
    if (retryTimer === undefined) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const scheduleRetry = (outage: Outage): void => {
    retry = retry ? mergeOutage(retry, outage) : outage;
    if (stopped || inFlight || retryTimer) return;
    const delay = retryDelayMs;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (stopped || !retry) return;
      void run(retry);
    }, delay);
    retryTimer.unref?.();
    retryDelayMs = Math.min(delay * 2, RECOVERY_RETRY_MAX_MS);
  };

  const run = (outage: Outage): Promise<void> => {
    if (stopped) return Promise.resolve();
    clearRetryTimer();
    if (inFlight) {
      queued = queued ? mergeOutage(queued, outage) : outage;
      return inFlight;
    }
    inFlight = (async () => {
      let current: Outage | undefined = retry ? mergeOutage(retry, outage) : outage;
      retry = undefined;
      try {
        while (current) {
          if (stopped) break;
          const ok = await runOnce(current);
          if (stopped) break;
          if (!ok) retry = retry ? mergeOutage(retry, current) : current;
          else retryDelayMs = RECOVERY_RETRY_MIN_MS;
          current = queued;
          queued = undefined;
          if (current && retry) {
            current = mergeOutage(retry, current);
            retry = undefined;
          }
        }
      } finally {
        inFlight = undefined;
        if (retry) scheduleRetry(retry);
      }
    })();
    return inFlight;
  };

  return {
    run,
    stop() {
      stopped = true;
      clearRetryTimer();
      retry = undefined;
      queued = undefined;
      return inFlight ?? Promise.resolve();
    },
  };
}

function outageReviewKey(outage: Outage): string {
  return `${outage.since}:${outage.until}:${outage.hostSuspended ? 1 : 0}`;
}

function mergeOutage(left: Outage, right: Outage): Outage {
  const suspendStartedAt = minDefined(left.suspendStartedAt, right.suspendStartedAt);
  return {
    since: Math.min(left.since, right.since),
    until: Math.max(left.until, right.until),
    hostSuspended: left.hostSuspended || right.hostSuspended,
    ...(suspendStartedAt !== undefined ? { suspendStartedAt } : {}),
  };
}

function minDefined(left?: number, right?: number): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}
