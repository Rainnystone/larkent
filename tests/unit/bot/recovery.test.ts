import { describe, expect, it } from 'vitest';
import { WATERMARK_MARGIN_MS } from '../../../src/bot/backfill';
import { createRecovery, type Outage } from '../../../src/bot/recovery';

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
});
