import { resolveBackfillWindow } from './backfill';
import { log } from '../core/logger';
import type { Outage } from './feishu-link';

export type { Outage };

/** After recovery, a run silent since before `outage.since` may keep running this long. */
export const STALL_AFTER_RECOVERY_MS = 2 * 60_000;

export interface ReviewableRun {
  lastEventAt: number;
  interrupted: boolean;
  /** True while the stream processor has a tool call in flight. */
  hasOpenToolCall?: boolean;
  /** Pending stall delay when the stream processor has not installed a hook yet. */
  stallDeadlineMs?: number;
  armStallDeadline?(delayMs: number): void;
}

export function reviewActiveRuns(runs: Iterable<ReviewableRun>, outage: Outage): void {
  for (const handle of runs) {
    if (handle.interrupted) continue;
    if (handle.lastEventAt >= outage.since) continue;
    // Open tool calls keep the 60-minute cap unless the host actually slept.
    if (handle.hasOpenToolCall && !outage.hostSuspended) continue;
    handle.stallDeadlineMs = STALL_AFTER_RECOVERY_MS;
    handle.armStallDeadline?.(STALL_AFTER_RECOVERY_MS);
  }
}

export interface RecoveryDeps {
  journal: { reapOrphans(): Promise<void>; redeliver(): Promise<void> };
  backfill: { scan(fromMs: number): Promise<void> };
  runs: { review(o: Outage): void };
  lookbackMs: () => number;
  now?: () => number;
  incompleteFrom?: () => number | undefined;
}

export interface Recovery {
  run(o: Outage): Promise<void>;
}

type RecoveryStep = 'reap' | 'redeliver' | 'backfill' | 'review';

export function createRecovery(deps: RecoveryDeps): Recovery {
  let inFlight: Promise<void> | undefined;
  let queued: Outage | undefined;
  let retry: Outage | undefined;

  const runStep = async (step: RecoveryStep, outage: Outage, work: () => Promise<void> | void): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (err) {
      log.fail('recovery', err, { step, since: outage.since, until: outage.until });
      return false;
    }
  };

  const runOnce = async (outage: Outage): Promise<void> => {
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
    const reapOk = await runStep('reap', outage, () => deps.journal.reapOrphans());
    const redeliverOk = await runStep('redeliver', outage, () => deps.journal.redeliver());
    const backfillOk = await runStep('backfill', outage, () => deps.backfill.scan(window.windowStart));
    const reviewOk = await runStep('review', outage, () => {
      deps.runs.review(outage);
    });
    if (!reapOk || !redeliverOk || !backfillOk || !reviewOk) {
      retry = retry ? mergeOutage(retry, outage) : outage;
    }
  };

  const run = (outage: Outage): Promise<void> => {
    if (inFlight) {
      queued = queued ? mergeOutage(queued, outage) : outage;
      return inFlight;
    }
    inFlight = (async () => {
      let current: Outage | undefined = retry ? mergeOutage(retry, outage) : outage;
      retry = undefined;
      try {
        while (current) {
          await runOnce(current);
          current = queued;
          queued = undefined;
          if (current && retry) {
            current = mergeOutage(retry, current);
            retry = undefined;
          }
        }
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return { run };
}

function mergeOutage(left: Outage, right: Outage): Outage {
  return {
    since: Math.min(left.since, right.since),
    until: Math.max(left.until, right.until),
    hostSuspended: left.hostSuspended || right.hostSuspended,
  };
}
