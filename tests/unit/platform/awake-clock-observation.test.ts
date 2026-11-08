import { describe, expect, it } from 'vitest';
import { AWAKE_TICK_MS, creditAwakeDelta } from '../../../src/bot/idle-watchdog';

const THIRTY_MIN = 30 * 60_000;

/**
 * Observed clocks on this runner (`process.platform`). Host suspend is not
 * executed. A 30-minute overdue-tick delta still credits one awake tick.
 */
describe(`awake clocks on ${process.platform}`, () => {
  it('Date, hrtime, and setTimeout advance together while this process is awake', async () => {
    const wall0 = Date.now();
    const hr0 = process.hrtime.bigint();
    const firedAt = await new Promise<number>((resolve) => {
      setTimeout(() => resolve(Date.now()), 40);
    });
    const wallMs = firedAt - wall0;
    const hrMs = Number(process.hrtime.bigint() - hr0) / 1e6;
    expect(wallMs).toBeGreaterThanOrEqual(20);
    expect(hrMs).toBeGreaterThanOrEqual(20);
  });

  it('caps a 30-minute overdue-tick delta to one awake tick', () => {
    expect(creditAwakeDelta(THIRTY_MIN)).toBe(AWAKE_TICK_MS);
    expect(creditAwakeDelta(-THIRTY_MIN)).toBe(0);
  });
});
