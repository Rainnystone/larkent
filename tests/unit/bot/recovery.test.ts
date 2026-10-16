import { describe, expect, it, vi } from 'vitest';
import { WATERMARK_MARGIN_MS } from '../../../src/bot/backfill';
import { createRecovery, reviewActiveRuns, type Outage, type ReviewableRun } from '../../../src/bot/recovery';

describe('Recovery', () => {
  it('redelivers, then scans the outage window, then reviews runs', async () => {
    const steps: string[] = [];
    const scanned: number[] = [];
    const reviewed: Outage[] = [];
    const outage = { since: 1_000, until: 5_000 };
    const recovery = createRecovery({
      journal: {
        reapOrphans: async () => {
          steps.push('reap');
        },
        redeliver: async () => {
          steps.push('redeliver');
        },
      },
      backfill: {
        scan: async (fromMs) => {
          steps.push('scan');
          scanned.push(fromMs);
        },
      },
      runs: {
        review: (o) => {
          steps.push('review');
          reviewed.push(o);
        },
      },
      lookbackMs: () => 6 * 60 * 60 * 1000,
      now: () => 5_000,
    });

    await recovery.run(outage);
    expect(steps).toEqual(['reap', 'redeliver', 'scan', 'review']);
    expect(scanned).toEqual([outage.since - WATERMARK_MARGIN_MS]);
    expect(reviewed).toEqual([outage]);
  });

  it('coalesces a second run onto one in flight and queues one follow-up', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scanned: number[] = [];
    const recovery = createRecovery({
      journal: {
        reapOrphans: async () => {
          await hold;
        },
        redeliver: async () => {},
      },
      backfill: {
        scan: async (fromMs) => {
          scanned.push(fromMs);
        },
      },
      runs: { review: () => {} },
      lookbackMs: () => 6 * 60 * 60 * 1000,
      now: () => 10_000,
    });

    const first = recovery.run({ since: 4_000, until: 8_000 });
    const second = recovery.run({ since: 1_000, until: 9_000 });
    const third = recovery.run({ since: 2_000, until: 9_500 });
    expect(second).toBe(first);
    expect(third).toBe(first);
    release();
    await first;
    expect(scanned).toEqual([
      4_000 - WATERMARK_MARGIN_MS,
      1_000 - WATERMARK_MARGIN_MS,
    ]);
  });

  it('arms a 2-minute stall only for runs silent since before the outage', () => {
    const silent: ReviewableRun = { lastEventAt: 900, interrupted: false, armStallDeadline: vi.fn() };
    const live: ReviewableRun = { lastEventAt: 1_000, interrupted: false, armStallDeadline: vi.fn() };
    const alreadyStopped: ReviewableRun = { lastEventAt: 100, interrupted: true, armStallDeadline: vi.fn() };
    const notYetStreaming: ReviewableRun = { lastEventAt: 800, interrupted: false };
    reviewActiveRuns([silent, live, alreadyStopped, notYetStreaming], { since: 1_000, until: 5_000 });
    expect(silent.armStallDeadline).toHaveBeenCalledWith(2 * 60_000);
    expect(silent.stallDeadlineMs).toBe(2 * 60_000);
    expect(live.armStallDeadline).not.toHaveBeenCalled();
    expect(live.stallDeadlineMs).toBeUndefined();
    expect(alreadyStopped.armStallDeadline).not.toHaveBeenCalled();
    expect(notYetStreaming.stallDeadlineMs).toBe(2 * 60_000);
  });
});
