import { resolveBackfillWindow } from './backfill';
import type { Outage } from './feishu-link';

export type { Outage };

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
    const window = resolveBackfillWindow({
      now,
      since: outage.since,
      incompleteFrom: deps.incompleteFrom?.(),
      lookbackMs: deps.lookbackMs(),
    });
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
