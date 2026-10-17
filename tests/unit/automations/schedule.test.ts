import { describe, expect, it } from 'vitest';
import {
  formatFireKey,
  isMissed,
  monthlyFireCount,
  nextFireAfter,
  nextFires,
  parseSchedule,
  planCatchUp,
  type Schedule,
  type ScheduleRejectReason,
} from '../../../src/automations/schedule';

const SHANGHAI = 'Asia/Shanghai';

describe('next fires (weekday, window, DST)', () => {
  it('weekday 09:00 next three fires skip Saturday and Sunday', () => {
    const parsed = parseSchedule(
      {
        kind: 'weekday',
        timezone: SHANGHAI,
        times: [{ hour: 9, minute: 0 }],
        startAt: Date.UTC(2026, 9, 16, 1, 0, 0),
        endAt: Date.UTC(2027, 9, 16, 1, 0, 0),
      },
      { taskType: 'reminder', now: Date.UTC(2026, 9, 15, 0, 0, 0) },
    );

    expect(parsed).toEqual({
      ok: true,
      schedule: expect.objectContaining({ kind: 'weekday' }),
    });
    if (!parsed.ok) return;

    // 2026-10-16 Fri / 17 Sat / 18 Sun / 19 Mon / 20 Tue. 09:00 CST = 01:00 UTC.
    expect(nextFires(parsed.schedule, Date.UTC(2026, 9, 15, 0, 0, 0), 3)).toEqual([
      Date.UTC(2026, 9, 16, 1, 0, 0),
      Date.UTC(2026, 9, 19, 1, 0, 0),
      Date.UTC(2026, 9, 20, 1, 0, 0),
    ]);
  });

  it('interval window 22:00–02:00 belongs to the start day and excludes 02:00', () => {
    const parsed = parseSchedule(
      {
        kind: 'interval',
        timezone: SHANGHAI,
        every: { unit: 'minutes', n: 30 },
        window: { from: { hour: 22, minute: 0 }, to: { hour: 2, minute: 0 } },
        startAt: Date.UTC(2026, 9, 16, 14, 0, 0),
        endAt: Date.UTC(2026, 10, 16, 14, 0, 0),
      },
      { taskType: 'reminder', now: Date.UTC(2026, 9, 16, 0, 0, 0) },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Friday 22:00 CST 16 Oct through Saturday 01:30 CST 17 Oct belong to Friday.
    expect(nextFires(parsed.schedule, Date.UTC(2026, 9, 16, 13, 0, 0), 9)).toEqual([
      Date.UTC(2026, 9, 16, 14, 0, 0), // 22:00 Fri
      Date.UTC(2026, 9, 16, 14, 30, 0),
      Date.UTC(2026, 9, 16, 15, 0, 0),
      Date.UTC(2026, 9, 16, 15, 30, 0),
      Date.UTC(2026, 9, 16, 16, 0, 0), // 00:00 Sat, still Friday's window
      Date.UTC(2026, 9, 16, 16, 30, 0),
      Date.UTC(2026, 9, 16, 17, 0, 0),
      Date.UTC(2026, 9, 16, 17, 30, 0), // 01:30
      Date.UTC(2026, 9, 17, 14, 0, 0), // next start-day 22:00 Sat; 02:00 excluded
    ]);
  });

  it('DST gap shifts a missing local time to the next valid minute', () => {
    const parsed = parseSchedule(
      {
        kind: 'daily',
        timezone: 'America/New_York',
        times: [{ hour: 2, minute: 30 }],
        startAt: Date.UTC(2026, 2, 7, 5, 0, 0),
        endAt: Date.UTC(2026, 3, 7, 5, 0, 0),
      },
      { taskType: 'reminder', now: Date.UTC(2026, 2, 7, 0, 0, 0) },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // 2026-03-08 02:00 EST → 03:00 EDT. 02:30 does not exist → 03:00 EDT = 07:00 UTC.
    expect(nextFires(parsed.schedule, Date.UTC(2026, 2, 8, 0, 0, 0), 1)).toEqual([
      Date.UTC(2026, 2, 8, 7, 0, 0),
    ]);
  });

  it('DST overlap fires the repeated local time only once', () => {
    const parsed = parseSchedule(
      {
        kind: 'daily',
        timezone: 'America/New_York',
        times: [{ hour: 1, minute: 30 }],
        startAt: Date.UTC(2026, 9, 31, 4, 0, 0),
        endAt: Date.UTC(2026, 10, 3, 5, 0, 0),
      },
      { taskType: 'reminder', now: Date.UTC(2026, 9, 31, 0, 0, 0) },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // 2026-11-01 01:30 happens twice; first occurrence is still EDT = 05:30 UTC.
    expect(nextFires(parsed.schedule, Date.UTC(2026, 10, 1, 0, 0, 0), 2)).toEqual([
      Date.UTC(2026, 10, 1, 5, 30, 0),
      Date.UTC(2026, 10, 2, 6, 30, 0),
    ]);
  });
});

describe('schedule floors and caps', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);

  it.each([
    {
      name: 'reminder one-shot closer than 10 minutes',
      input: { kind: 'one-shot', fireAt: now + 9 * 60_000 },
      taskType: 'reminder' as const,
      reason: 'lead-too-soon' satisfies ScheduleRejectReason,
    },
    {
      name: 'agent one-shot closer than 10 minutes',
      input: { kind: 'one-shot', fireAt: now + 9 * 60_000 },
      taskType: 'agent' as const,
      reason: 'lead-too-soon' satisfies ScheduleRejectReason,
    },
    {
      name: 'one-shot more than 1 year ahead',
      input: { kind: 'one-shot', fireAt: now + 365 * 24 * 60 * 60_000 + 1 },
      taskType: 'reminder' as const,
      reason: 'one-shot-too-far' satisfies ScheduleRejectReason,
    },
    {
      name: 'recurring without endAt',
      input: {
        kind: 'daily',
        timezone: SHANGHAI,
        times: [{ hour: 9, minute: 0 }],
        startAt: now,
      },
      taskType: 'reminder' as const,
      reason: 'missing-end-at' satisfies ScheduleRejectReason,
    },
    {
      name: 'recurring longer than 1 year',
      input: {
        kind: 'daily',
        timezone: SHANGHAI,
        times: [{ hour: 9, minute: 0 }],
        startAt: now,
        endAt: now + 365 * 24 * 60 * 60_000 + 1,
      },
      taskType: 'reminder' as const,
      reason: 'recurring-too-long' satisfies ScheduleRejectReason,
    },
    {
      name: 'reminder interval under 10 minutes',
      input: {
        kind: 'interval',
        timezone: SHANGHAI,
        every: { unit: 'minutes', n: 9 },
        startAt: now,
        endAt: now + 30 * 24 * 60 * 60_000,
      },
      taskType: 'reminder' as const,
      reason: 'interval-too-small' satisfies ScheduleRejectReason,
    },
    {
      name: 'agent interval under 1 hour',
      input: {
        kind: 'interval',
        timezone: SHANGHAI,
        every: { unit: 'minutes', n: 30 },
        startAt: now,
        endAt: now + 30 * 24 * 60 * 60_000,
      },
      taskType: 'agent' as const,
      reason: 'interval-too-small' satisfies ScheduleRejectReason,
    },
    {
      name: 'invalid IANA timezone',
      input: {
        kind: 'daily',
        timezone: 'Not/AZone',
        times: [{ hour: 9, minute: 0 }],
        startAt: now,
        endAt: now + 30 * 24 * 60 * 60_000,
      },
      taskType: 'reminder' as const,
      reason: 'invalid-timezone' satisfies ScheduleRejectReason,
    },
    {
      name: 'reminder daily times 5 minutes apart',
      input: {
        kind: 'daily',
        timezone: SHANGHAI,
        times: [
          { hour: 9, minute: 0 },
          { hour: 9, minute: 5 },
        ],
        startAt: now,
        endAt: now + 30 * 24 * 60 * 60_000,
      },
      taskType: 'reminder' as const,
      reason: 'interval-too-small' satisfies ScheduleRejectReason,
    },
  ])('rejects $name with $reason', ({ input, taskType, reason }) => {
    expect(parseSchedule(input, { taskType, now })).toEqual({ ok: false, reason });
  });

  it('accepts a reminder one-shot exactly 10 minutes ahead', () => {
    const fireAt = now + 10 * 60_000;
    expect(parseSchedule({ kind: 'one-shot', fireAt }, { taskType: 'reminder', now })).toEqual({
      ok: true,
      schedule: { kind: 'one-shot', fireAt },
    });
  });

  it('accepts an agent one-shot 30 minutes ahead (1 h floor is interval, not lead)', () => {
    const fireAt = now + 30 * 60_000;
    expect(parseSchedule({ kind: 'one-shot', fireAt }, { taskType: 'agent', now })).toEqual({
      ok: true,
      schedule: { kind: 'one-shot', fireAt },
    });
  });
});

describe('miss rule and catch-up', () => {
  const hourly: Schedule = {
    kind: 'interval',
    timezone: SHANGHAI,
    everyMs: 60 * 60_000,
    startAt: Date.UTC(2026, 0, 1, 0, 0, 0),
    endAt: Date.UTC(2026, 0, 31, 0, 0, 0),
  };
  const t0 = Date.UTC(2026, 0, 2, 12, 0, 0);

  it.each([
    {
      name: 'now == nextFireAt',
      item: { id: 3, paused: false, nextFireAt: t0, lastFireAt: 0, schedule: hourly },
      now: t0,
    },
    {
      name: 'paused',
      item: { id: 3, paused: true, nextFireAt: t0, lastFireAt: 0, schedule: hourly },
      now: t0 + 1,
    },
    {
      name: 'lastFireAt == nextFireAt',
      item: { id: 3, paused: false, nextFireAt: t0, lastFireAt: t0, schedule: hourly },
      now: t0 + 1,
    },
    {
      name: 'nextFireAt == 0',
      item: { id: 3, paused: false, nextFireAt: 0, lastFireAt: 0, schedule: hourly },
      now: t0,
    },
  ])('is not missed when $name', ({ item, now }) => {
    expect(isMissed(item, now)).toBe(false);
    expect(planCatchUp(item, now)).toEqual({ missedFires: [] });
  });

  it('catch-up at exactly 24 h still runs that instant', () => {
    const schedule: Schedule = { kind: 'one-shot', fireAt: t0 };
    const item = { id: 3, paused: false, nextFireAt: t0, lastFireAt: 0, schedule };
    const now = t0 + 24 * 60 * 60_000;
    expect(isMissed(item, now)).toBe(true);
    expect(planCatchUp(item, now)).toEqual({ run: t0, missedFires: [] });
  });

  it('catch-up at 24 h + 1 ms lists the instant as missed and does not run', () => {
    const schedule: Schedule = { kind: 'one-shot', fireAt: t0 };
    const item = { id: 3, paused: false, nextFireAt: t0, lastFireAt: 0, schedule };
    const now = t0 + 24 * 60 * 60_000 + 1;
    expect(planCatchUp(item, now)).toEqual({ missedFires: [t0] });
  });

  it('three missed instants within 24 h run the latest and list the other two', () => {
    const item = { id: 3, paused: false, nextFireAt: t0, lastFireAt: 0, schedule: hourly };
    const now = t0 + 2 * 60 * 60_000 + 1;
    expect(planCatchUp(item, now)).toEqual({
      run: t0 + 2 * 60 * 60_000,
      missedFires: [t0, t0 + 60 * 60_000],
    });
  });

  it('does not catch-up a fire that is due exactly now', () => {
    const item = { id: 3, paused: false, nextFireAt: t0, lastFireAt: 0, schedule: hourly };
    const now = t0 + 2 * 60 * 60_000;
    expect(planCatchUp(item, now)).toEqual({
      run: t0 + 60 * 60_000,
      missedFires: [t0],
    });
  });

  it('one-shot missed > 24 h has no run, one missed instant, and next fire 0', () => {
    const fireAt = Date.UTC(2026, 0, 2, 12, 0, 0);
    const parsed = parseSchedule(
      { kind: 'one-shot', fireAt },
      { taskType: 'reminder', now: fireAt - 20 * 60_000 },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const item = { id: 7, paused: false, nextFireAt: fireAt, lastFireAt: 0, schedule: parsed.schedule };
    const now = fireAt + 24 * 60 * 60_000 + 1;
    expect(planCatchUp(item, now)).toEqual({ missedFires: [fireAt] });
    expect(nextFireAfter(parsed.schedule, now)).toBe(0);
  });

  it('formats a fire key as id@fireAt', () => {
    expect(formatFireKey(3, 1792218600000)).toBe('3@1792218600000');
  });
});

describe('weekly and monthly count', () => {
  it('weekly selected weekdays emit the next three local times', () => {
    const parsed = parseSchedule(
      {
        kind: 'weekly',
        timezone: SHANGHAI,
        weekdays: [1, 3],
        times: [{ hour: 9, minute: 0 }],
        startAt: Date.UTC(2026, 9, 12, 1, 0, 0),
        endAt: Date.UTC(2027, 9, 12, 1, 0, 0),
      },
      { taskType: 'reminder', now: Date.UTC(2026, 9, 12, 0, 0, 0) },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Mon 12 Oct, Wed 14 Oct, Mon 19 Oct. 09:00 CST = 01:00 UTC.
    expect(nextFires(parsed.schedule, Date.UTC(2026, 9, 11, 0, 0, 0), 3)).toEqual([
      Date.UTC(2026, 9, 12, 1, 0, 0),
      Date.UTC(2026, 9, 14, 1, 0, 0),
      Date.UTC(2026, 9, 19, 1, 0, 0),
    ]);
  });

  it('estimates about-per-month fires for the confirm card', () => {
    const daily = parseSchedule(
      {
        kind: 'daily',
        timezone: SHANGHAI,
        times: [{ hour: 9, minute: 0 }],
        startAt: Date.UTC(2026, 0, 1, 1, 0, 0),
        endAt: Date.UTC(2026, 11, 31, 1, 0, 0),
      },
      { taskType: 'reminder', now: Date.UTC(2026, 0, 1, 0, 0, 0) },
    );
    expect(daily.ok).toBe(true);
    if (!daily.ok) return;
    expect(monthlyFireCount(daily.schedule, Date.UTC(2026, 0, 1, 0, 0, 0))).toBe(30);

    const weekday = parseSchedule(
      {
        kind: 'weekday',
        timezone: SHANGHAI,
        times: [{ hour: 9, minute: 0 }],
        startAt: Date.UTC(2026, 0, 1, 1, 0, 0),
        endAt: Date.UTC(2026, 11, 31, 1, 0, 0),
      },
      { taskType: 'reminder', now: Date.UTC(2026, 0, 1, 0, 0, 0) },
    );
    expect(weekday.ok).toBe(true);
    if (!weekday.ok) return;
    expect(monthlyFireCount(weekday.schedule, Date.UTC(2026, 0, 1, 0, 0, 0))).toBe(22);
  });
});
