import { resolveBackfillWindow } from './backfill';
import { log } from '../core/logger';
import type { Outage } from './feishu-link';

export type { Outage };

/** After recovery, a run silent since before `outage.since` may keep running this long. */
export const STALL_AFTER_RECOVERY_MS = 2 * 60_000;

export interface ReviewableRun {
  lastEventAt: number;
  interrupted: boolean;
  /** Pending stall delay when the stream processor has not installed a hook yet. */
  stallDeadlineMs?: number;
  armStallDeadline?(delayMs: number): void;
}

export function reviewActiveRuns(runs: Iterable<ReviewableRun>, outage: Outage): void {
  for (const handle of runs) {
    if (handle.interrupted) continue;
    if (handle.lastEventAt >= outage.since) continue;
    // Silent before the outage: 2 min from recovery, including an open tool.
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

export function createRecovery(deps: RecoveryDeps): Recovery {
  let inFlight: Promise<void> | undefined;
  let queued: Outage | undefined;

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
    await deps.journal.reapOrphans();
    await deps.journal.redeliver();
    await deps.backfill.scan(window.windowStart);
    deps.runs.review(outage);
  };

  const run = (outage: Outage): Promise<void> => {
    if (inFlight) {
      queued = queued ? mergeOutage(queued, outage) : outage;
      return inFlight;
    }
    inFlight = (async () => {
      let current: Outage | undefined = outage;
      try {
        while (current) {
          await runOnce(current);
          current = queued;
          queued = undefined;
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
  };
}
