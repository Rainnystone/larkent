import { describe, expect, it, vi } from 'vitest';
import { WATERMARK_MARGIN_MS } from '../../../src/bot/backfill';
import { createRecovery, reviewActiveRuns, type Outage, type ReviewableRun } from '../../../src/bot/recovery';
import { log } from '../../../src/core/logger';

describe('Recovery', () => {
  it('redelivers, then scans the outage window, then reviews runs', async () => {
    const steps: string[] = [];
    const scanned: number[] = [];
    const reviewed: Outage[] = [];
    const outage = { since: 1_000, until: 5_000, hostSuspended: false };
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

    const first = recovery.run({ since: 4_000, until: 8_000, hostSuspended: false });
    const second = recovery.run({ since: 1_000, until: 9_000, hostSuspended: true });
    const third = recovery.run({ since: 2_000, until: 9_500, hostSuspended: false });
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
    reviewActiveRuns([silent, live, alreadyStopped, notYetStreaming], {
      since: 1_000,
      until: 5_000,
      hostSuspended: false,
    });
    expect(silent.armStallDeadline).toHaveBeenCalledWith(2 * 60_000);
    expect(silent.stallDeadlineMs).toBe(2 * 60_000);
    expect(live.armStallDeadline).not.toHaveBeenCalled();
    expect(live.stallDeadlineMs).toBeUndefined();
    expect(alreadyStopped.armStallDeadline).not.toHaveBeenCalled();
    expect(notYetStreaming.stallDeadlineMs).toBe(2 * 60_000);
  });

  it('logs window-truncated once per recovery when the outage exceeds lookback', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const lookbackMs = 6 * 60 * 60 * 1000;
    const now = 8 * 60 * 60 * 1000;
    const recovery = createRecovery({
      journal: {
        reapOrphans: async () => {},
        redeliver: async () => {},
      },
      backfill: { scan: async () => {} },
      runs: { review: () => {} },
      lookbackMs: () => lookbackMs,
      now: () => now,
    });
    const longOutage = { since: now - 7 * 60 * 60 * 1000, until: now, hostSuspended: false };
    await recovery.run(longOutage);
    expect(info.mock.calls.filter((call) => call[0] === 'backfill' && call[1] === 'window-truncated')).toHaveLength(1);
    await recovery.run(longOutage);
    expect(info.mock.calls.filter((call) => call[0] === 'backfill' && call[1] === 'window-truncated')).toHaveLength(2);

    info.mockClear();
    await recovery.run({ since: now - 3 * 60 * 60 * 1000, until: now, hostSuspended: false });
    expect(info.mock.calls.filter((call) => call[0] === 'backfill' && call[1] === 'window-truncated')).toHaveLength(0);
  });

  it('still reviews and retries the window when backfill throws', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const scanned: number[] = [];
    const reviewed: Outage[] = [];
    let scans = 0;
    const outage: Outage = { since: 1_000, until: 5_000, hostSuspended: false };
    const recovery = createRecovery({
      journal: {
        reapOrphans: async () => {},
        redeliver: async () => {},
      },
      backfill: {
        scan: async (fromMs) => {
          scans += 1;
          scanned.push(fromMs);
          if (scans === 1) throw new Error('backfill boom');
        },
      },
      runs: {
        review: (o) => {
          reviewed.push(o);
        },
      },
      lookbackMs: () => 6 * 60 * 60 * 1000,
      now: () => 5_000,
    });

    await recovery.run(outage);
    expect(reviewed).toEqual([outage]);
    expect(scanned).toEqual([outage.since - WATERMARK_MARGIN_MS]);
    expect(fail.mock.calls.some((call) => call[0] === 'recovery')).toBe(true);

    await recovery.run({ since: 8_000, until: 9_000, hostSuspended: false });
    expect(scanned).toEqual([
      outage.since - WATERMARK_MARGIN_MS,
      outage.since - WATERMARK_MARGIN_MS,
    ]);
    expect(reviewed).toHaveLength(2);
  });

  it('still backfills and reviews when journal flush throws during redeliver', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const steps: string[] = [];
    let redeliveries = 0;
    const recovery = createRecovery({
      journal: {
        reapOrphans: async () => {
          steps.push('reap');
        },
        redeliver: async () => {
          redeliveries += 1;
          steps.push('redeliver');
          if (redeliveries === 1) throw new Error('ENOSPC journal persist');
        },
      },
      backfill: {
        scan: async () => {
          steps.push('scan');
        },
      },
      runs: {
        review: () => {
          steps.push('review');
        },
      },
      lookbackMs: () => 6 * 60 * 60 * 1000,
      now: () => 5_000,
    });

    await recovery.run({ since: 1_000, until: 5_000, hostSuspended: false });
    expect(steps).toEqual(['reap', 'redeliver', 'scan', 'review']);
    expect(fail.mock.calls.some((call) => call[0] === 'recovery')).toBe(true);

    await recovery.run({ since: 6_000, until: 7_000, hostSuspended: true });
    expect(steps).toEqual([
      'reap', 'redeliver', 'scan', 'review',
      'reap', 'redeliver', 'scan', 'review',
    ]);
  });

  it('does not deadline an open tool call after a network-only outage', () => {
    const openTool: ReviewableRun = {
      lastEventAt: 900,
      interrupted: false,
      hasOpenToolCall: true,
      armStallDeadline: vi.fn(),
    };
    reviewActiveRuns([openTool], { since: 1_000, until: 5_000, hostSuspended: false });
    expect(openTool.armStallDeadline).not.toHaveBeenCalled();
    expect(openTool.stallDeadlineMs).toBeUndefined();
  });

  it('deadlines an open tool call only after a host suspend', () => {
    const openTool: ReviewableRun = {
      lastEventAt: 900,
      interrupted: false,
      hasOpenToolCall: true,
      armStallDeadline: vi.fn(),
    };
    reviewActiveRuns([openTool], { since: 1_000, until: 5_000, hostSuspended: true });
    expect(openTool.armStallDeadline).toHaveBeenCalledWith(2 * 60_000);
    expect(openTool.stallDeadlineMs).toBe(2 * 60_000);
  });
});
