import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseScheduleText } from '../../../src/automations/command';
import { nextFires, type Schedule } from '../../../src/automations/schedule';

/** 2026-10-18 15:05 Asia/Shanghai, independent of the host zone. */
const NOW = Date.UTC(2026, 9, 18, 7, 5, 0);
const SH = 'Asia/Shanghai';
const NY = 'America/New_York';

const TODAY_1550 = Date.UTC(2026, 9, 18, 7, 50, 0);
const TOMORROW_0900 = Date.UTC(2026, 9, 19, 1, 0, 0);
const DAY_AFTER_0900 = Date.UTC(2026, 9, 20, 1, 0, 0);
const TOMORROW_1500 = Date.UTC(2026, 9, 19, 7, 0, 0);
const TOMORROW_1540 = Date.UTC(2026, 9, 19, 7, 40, 0);
const TOMORROW_0000 = Date.UTC(2026, 9, 18, 16, 0, 0);

describe('parseScheduleText day-time and start prefix', () => {
  const previousTz = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = 'UTC';
  });

  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it('resolves 今天/明天/后天 and a fullwidth colon in Asia/Shanghai', () => {
    expect(fireAt('今天 15:50')).toBe(TODAY_1550);
    expect(fireAt('明天 09:00')).toBe(TOMORROW_0900);
    expect(fireAt('后天 9:00')).toBe(DAY_AFTER_0900);
    expect(fireAt('今天 15：50')).toBe(TODAY_1550);
  });

  it('rejects a passed 今天 time and a 今天 time inside the 10 minute floor', () => {
    expect(reason('今天 15:00')).toBe('past-time');
    expect(reason('今天 15:05')).toBe('past-time');
    expect(reason('今天 15:12')).toBe('lead-too-soon');
    expect(fireAt('今天 15:15')).toBe(Date.UTC(2026, 9, 18, 7, 15, 0));
  });

  it('treats a bare clock as the next occurrence, except inside the floor', () => {
    expect(fireAt('15:50')).toBe(TODAY_1550);
    expect(fireAt('15:00')).toBe(TOMORROW_1500);
    expect(fireAt('15：00')).toBe(TOMORROW_1500);
    expect(fireAt('00:00')).toBe(TOMORROW_0000);
    expect(fireAt('15:05')).toBe(Date.UTC(2026, 9, 19, 7, 5, 0));
    expect(reason('15:12')).toBe('lead-too-soon');
  });

  it('starts a recurring rule at the prefixed local time and skips today', () => {
    const text = '从 明天 15:40 起 every 10m 15:40-16:05 until 2026-10-19 16:05';
    const schedule = recurring(text);
    expect(schedule.kind).toBe('interval');
    if (schedule.kind !== 'interval') return;
    expect(schedule.startAt).toBe(TOMORROW_1540);
    const fires = nextFires(schedule, NOW, 4);
    expect(fires[0]).toBe(TOMORROW_1540);
    expect(fires).toEqual([
      TOMORROW_1540,
      Date.UTC(2026, 9, 19, 7, 50, 0),
      Date.UTC(2026, 9, 19, 8, 0, 0),
    ]);
    expect(fires.some((fire) => fire < TOMORROW_0000)).toBe(false);
  });

  it('accepts an English from-date prefix and a date with the clock omitted', () => {
    const english = recurring('from 2026-10-19 15:40 every 10m 15:40-16:05 until 2026-10-19 16:05');
    if (english.kind !== 'interval') throw new Error('expected interval');
    expect(english.startAt).toBe(TOMORROW_1540);

    const omitted = recurring('从 明天 起 every 10m until 2026-10-20');
    if (omitted.kind !== 'interval') throw new Error('expected interval');
    expect(omitted.startAt).toBe(TOMORROW_0000);
  });

  it('does not fire a same-day clock that is earlier than the start', () => {
    const daily = recurring('从 明天 15：40 起 每天 09:00 到 2026-12-31');
    expect(daily.kind).toBe('daily');
    if (daily.kind !== 'daily') return;
    expect(daily.startAt).toBe(TOMORROW_1540);
    expect(nextFires(daily, NOW, 1)).toEqual([Date.UTC(2026, 9, 20, 1, 0, 0)]);
  });

  it('rejects a too-short interval before asking for an end, even with a start prefix', () => {
    expect(parseScheduleText('从 明天 起 every 5m', options())).toEqual({
      ok: false,
      reason: 'interval-too-small',
    });
  });

  it('keeps a future start when the end time is still missing', () => {
    expect(parseScheduleText('从 明天 15:40 起 every 10m 15:40-16:05', options())).toMatchObject({
      ok: false,
      reason: 'missing-end-at',
      startAt: TOMORROW_1540,
      pending: { kind: 'interval', every: { unit: 'minutes', n: 10 } },
    });
  });

  it('rejects an unrecognized start, a start before today, an end at or before the start, and a start past one year', () => {
    expect(reason('从 昨天 起 every 10m until 2026-10-19')).toBe('invalid-start');
    expect(reason('从 2026-10-17 起 every 10m until 2026-10-19')).toBe('start-before-today');
    expect(reason('从 明天 15:40 起 every 10m 15:40-16:05 until 2026-10-19 15:40')).toBe('end-not-after-start');
    expect(reason('从 2027-10-19 起 every 10m until 2027-10-20')).toBe('start-too-far');
    expect(reason('从 明天 15:40 every 10m until 2026-10-19')).toBe('invalid-start');
  });

  it('does not invent dates such as 下周一', () => {
    expect(reason('下周一 09:00')).toBe('invalid-schedule');
  });

  it('uses the task timezone when the host zone is UTC', () => {
    expect(fireAt('今天 15:50', NY)).toBe(Date.UTC(2026, 9, 18, 19, 50, 0));
    expect(fireAt('明天 09:00', NY)).toBe(Date.UTC(2026, 9, 19, 13, 0, 0));
    expect(reason('今天 03:00', NY)).toBe('past-time');
    expect(fireAt('15:50', NY)).toBe(Date.UTC(2026, 9, 18, 19, 50, 0));
    expect(fireAt('03:00', NY)).toBe(Date.UTC(2026, 9, 19, 7, 0, 0));
    expect(reason('03:10', NY)).toBe('lead-too-soon');
  });

  it('shifts a missing local time forward and keeps the first repeated local time', () => {
    const springNow = Date.UTC(2026, 2, 8, 6, 0, 0);
    expect(parseScheduleText('2026-03-08 02:30', {
      taskType: 'reminder',
      now: springNow,
      timezone: NY,
    })).toEqual({
      ok: true,
      schedule: { kind: 'one-shot', fireAt: Date.UTC(2026, 2, 8, 7, 0, 0) },
    });

    const fallNow = Date.UTC(2026, 10, 1, 4, 30, 0);
    expect(parseScheduleText('2026-11-01 01:30', {
      taskType: 'reminder',
      now: fallNow,
      timezone: NY,
    })).toEqual({
      ok: true,
      schedule: { kind: 'one-shot', fireAt: Date.UTC(2026, 10, 1, 5, 30, 0) },
    });
  });
});

function options(timezone = SH) {
  return { taskType: 'reminder' as const, now: NOW, timezone };
}

function fireAt(text: string, timezone = SH): number {
  const parsed = parseScheduleText(text, options(timezone));
  if (!parsed.ok || parsed.schedule.kind !== 'one-shot') {
    throw new Error(`expected one-shot for ${text}, got ${JSON.stringify(parsed)}`);
  }
  return parsed.schedule.fireAt;
}

function reason(text: string, timezone = SH): string {
  const parsed = parseScheduleText(text, options(timezone));
  if (parsed.ok) throw new Error(`expected reject for ${text}`);
  return parsed.reason;
}

function recurring(text: string): Schedule {
  const parsed = parseScheduleText(text, options());
  if (!parsed.ok) throw new Error(`expected schedule for ${text}: ${parsed.reason}`);
  return parsed.schedule;
}
