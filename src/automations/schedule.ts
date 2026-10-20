import { addLocalDays, addLocalMonths, isValidTimeZone, zonedLocalToUtc, zonedParts } from './zoned-time';

export const REMINDER_MIN_INTERVAL_MS = 10 * 60_000;
export const AGENT_MIN_INTERVAL_MS = 60 * 60_000;
export const ONE_YEAR_MS = 365 * 24 * 60 * 60_000;
export const CATCH_UP_WINDOW_MS = 24 * 60 * 60_000;

export type TaskType = 'reminder' | 'agent';

export type LocalTime = { hour: number; minute: number };

export type Schedule =
  | { kind: 'one-shot'; fireAt: number }
  | {
      kind: 'daily';
      timezone: string;
      times: readonly LocalTime[];
      startAt: number;
      endAt: number;
    }
  | {
      kind: 'weekday';
      timezone: string;
      times: readonly LocalTime[];
      startAt: number;
      endAt: number;
    }
  | {
      kind: 'weekly';
      timezone: string;
      weekdays: readonly number[];
      times: readonly LocalTime[];
      startAt: number;
      endAt: number;
    }
  | {
      kind: 'interval';
      timezone: string;
      everyMs: number;
      window?: { from: LocalTime; to: LocalTime };
      startAt: number;
      endAt: number;
    };

export type ScheduleRejectReason =
  | 'invalid-timezone'
  | 'missing-end-at'
  | 'lead-too-soon'
  | 'interval-too-small'
  | 'one-shot-too-far'
  | 'recurring-too-long'
  | 'invalid-schedule';

export type ParseScheduleResult =
  | { ok: true; schedule: Schedule }
  | { ok: false; reason: ScheduleRejectReason };

/** Recurring rule captured from `/auto new` before an end time is supplied. */
export type PendingRecurring = {
  kind: 'daily' | 'weekday' | 'weekly' | 'interval';
  timezone: string;
  times?: LocalTime[];
  weekdays?: number[];
  every?: { unit: 'minutes' | 'hours'; n: number };
  window?: { from: LocalTime; to: LocalTime };
};

export interface ParseScheduleOptions {
  taskType: TaskType;
  now: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function fail(reason: ScheduleRejectReason): ParseScheduleResult {
  return { ok: false, reason };
}

function minIntervalMs(taskType: TaskType): number {
  return taskType === 'agent' ? AGENT_MIN_INTERVAL_MS : REMINDER_MIN_INTERVAL_MS;
}

function isLocalTime(value: unknown): value is LocalTime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.hour === 'number' &&
    Number.isInteger(rec.hour) &&
    rec.hour >= 0 &&
    rec.hour <= 23 &&
    typeof rec.minute === 'number' &&
    Number.isInteger(rec.minute) &&
    rec.minute >= 0 &&
    rec.minute <= 59
  );
}

function readTimes(value: unknown): LocalTime[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const times: LocalTime[] = [];
  for (const entry of value) {
    if (!isLocalTime(entry)) return undefined;
    times.push({ hour: entry.hour, minute: entry.minute });
  }
  times.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  return times;
}

function adjacentIntervalOk(times: readonly LocalTime[], minMs: number): boolean {
  if (times.length === 1) return true;
  const minutes = times.map((time) => time.hour * 60 + time.minute);
  for (let i = 1; i < minutes.length; i += 1) {
    const prev = minutes[i - 1];
    const next = minutes[i];
    if (prev === undefined || next === undefined) continue;
    if ((next - prev) * 60_000 < minMs) return false;
  }
  const first = minutes[0];
  const last = minutes[minutes.length - 1];
  if (first === undefined || last === undefined) return true;
  if ((first + 24 * 60 - last) * 60_000 < minMs) return false;
  return true;
}

function parseRecurringBounds(
  input: Record<string, unknown>,
  now: number,
): { startAt: number; endAt: number } | ScheduleRejectReason {
  if (typeof input.endAt !== 'number' || !Number.isFinite(input.endAt)) return 'missing-end-at';
  const startAt = typeof input.startAt === 'number' && Number.isFinite(input.startAt) ? input.startAt : now;
  if (input.endAt - startAt > ONE_YEAR_MS) return 'recurring-too-long';
  if (input.endAt <= startAt) return 'invalid-schedule';
  return { startAt, endAt: input.endAt };
}

function parseEveryMs(value: unknown): number | undefined {
  const rec = asRecord(value);
  if (!rec || (rec.unit !== 'minutes' && rec.unit !== 'hours')) return undefined;
  if (typeof rec.n !== 'number' || !Number.isInteger(rec.n) || rec.n < 1) return undefined;
  return rec.unit === 'hours' ? rec.n * 3_600_000 : rec.n * 60_000;
}

function parseWeekdays(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const days: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1 || entry > 7) return undefined;
    if (!days.includes(entry)) days.push(entry);
  }
  days.sort((a, b) => a - b);
  return days;
}

function readTimezone(value: unknown): string | undefined {
  return typeof value === 'string' && isValidTimeZone(value) ? value : undefined;
}

function parseTimedRecurring(
  input: Record<string, unknown>,
  options: ParseScheduleOptions,
):
  | { timezone: string; times: LocalTime[]; startAt: number; endAt: number }
  | ScheduleRejectReason {
  const timezone = readTimezone(input.timezone);
  if (!timezone) return 'invalid-timezone';
  const times = readTimes(input.times);
  if (!times) return 'invalid-schedule';
  const bounds = parseRecurringBounds(input, options.now);
  if (typeof bounds === 'string') return bounds;
  if (!adjacentIntervalOk(times, minIntervalMs(options.taskType))) return 'interval-too-small';
  return { timezone, times, ...bounds };
}

function parseWindow(value: unknown): { from: LocalTime; to: LocalTime } | undefined | 'invalid' {
  if (value === undefined) return undefined;
  const rec = asRecord(value);
  if (!rec || !isLocalTime(rec.from) || !isLocalTime(rec.to)) return 'invalid';
  if (rec.from.hour === rec.to.hour && rec.from.minute === rec.to.minute) return 'invalid';
  return {
    from: { hour: rec.from.hour, minute: rec.from.minute },
    to: { hour: rec.to.hour, minute: rec.to.minute },
  };
}

export function parseSchedule(input: unknown, options: ParseScheduleOptions): ParseScheduleResult {
  const rec = asRecord(input);
  if (!rec || typeof rec.kind !== 'string') return fail('invalid-schedule');

  switch (rec.kind) {
    case 'weekday': {
      const parsed = parseTimedRecurring(rec, options);
      if (typeof parsed === 'string') return fail(parsed);
      return { ok: true, schedule: { kind: 'weekday', ...parsed } };
    }
    case 'daily': {
      const parsed = parseTimedRecurring(rec, options);
      if (typeof parsed === 'string') return fail(parsed);
      return { ok: true, schedule: { kind: 'daily', ...parsed } };
    }
    case 'interval': {
      const timezone = readTimezone(rec.timezone);
      if (!timezone) return fail('invalid-timezone');
      const everyMs = parseEveryMs(rec.every);
      if (everyMs === undefined) return fail('invalid-schedule');
      if (everyMs < minIntervalMs(options.taskType)) return fail('interval-too-small');
      const window = parseWindow(rec.window);
      if (window === 'invalid') return fail('invalid-schedule');
      const bounds = parseRecurringBounds(rec, options.now);
      if (typeof bounds === 'string') return fail(bounds);
      return {
        ok: true,
        schedule: window
          ? { kind: 'interval', timezone, everyMs, window, ...bounds }
          : { kind: 'interval', timezone, everyMs, ...bounds },
      };
    }
    case 'one-shot': {
      if (typeof rec.fireAt !== 'number' || !Number.isFinite(rec.fireAt)) return fail('invalid-schedule');
      const lead = rec.fireAt - options.now;
      if (lead > ONE_YEAR_MS) return fail('one-shot-too-far');
      if (lead < REMINDER_MIN_INTERVAL_MS) return fail('lead-too-soon');
      return { ok: true, schedule: { kind: 'one-shot', fireAt: rec.fireAt } };
    }
    case 'weekly': {
      const parsed = parseTimedRecurring(rec, options);
      if (typeof parsed === 'string') return fail(parsed);
      const weekdays = parseWeekdays(rec.weekdays);
      if (!weekdays) return fail('invalid-schedule');
      return { ok: true, schedule: { kind: 'weekly', weekdays, ...parsed } };
    }
    default:
      return fail('invalid-schedule');
  }
}

function localDateOf(timeZone: string, utcMs: number): { year: number; month: number; day: number; weekday: number } {
  const parts = zonedParts(timeZone, utcMs);
  return { year: parts.year, month: parts.month, day: parts.day, weekday: parts.weekday };
}

function dayMatches(
  schedule: Extract<Schedule, { kind: 'daily' | 'weekday' | 'weekly' }>,
  weekday: number,
): boolean {
  switch (schedule.kind) {
    case 'daily':
      return true;
    case 'weekday':
      return weekday <= 5;
    case 'weekly':
      return schedule.weekdays.includes(weekday);
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}

function firesOnLocalDay(
  schedule: Extract<Schedule, { kind: 'daily' | 'weekday' | 'weekly' }>,
  year: number,
  month: number,
  day: number,
  weekday: number,
): number[] {
  if (!dayMatches(schedule, weekday)) return [];
  const instants: number[] = [];
  for (const time of schedule.times) {
    const utc = zonedLocalToUtc(schedule.timezone, year, month, day, time.hour, time.minute);
    if (utc >= schedule.startAt && utc < schedule.endAt) instants.push(utc);
  }
  return instants;
}

function windowEndLocalDay(
  start: { year: number; month: number; day: number },
  window: { from: LocalTime; to: LocalTime },
): { year: number; month: number; day: number } {
  const fromMin = window.from.hour * 60 + window.from.minute;
  const toMin = window.to.hour * 60 + window.to.minute;
  return toMin <= fromMin ? addLocalDays(start.year, start.month, start.day, 1) : start;
}

function intervalFiresOnStartDay(
  schedule: Extract<Schedule, { kind: 'interval' }>,
  year: number,
  month: number,
  day: number,
): number[] {
  if (!schedule.window) {
    return [];
  }
  const start = zonedLocalToUtc(
    schedule.timezone,
    year,
    month,
    day,
    schedule.window.from.hour,
    schedule.window.from.minute,
  );
  const endDay = windowEndLocalDay({ year, month, day }, schedule.window);
  const end = zonedLocalToUtc(
    schedule.timezone,
    endDay.year,
    endDay.month,
    endDay.day,
    schedule.window.to.hour,
    schedule.window.to.minute,
  );
  const instants: number[] = [];
  for (let utc = start; utc < end; utc += schedule.everyMs) {
    if (utc >= schedule.startAt && utc < schedule.endAt) instants.push(utc);
  }
  return instants;
}

function nextCalendarFire(
  schedule: Extract<Schedule, { kind: 'daily' | 'weekday' | 'weekly' }>,
  afterMs: number,
): number {
  const start = localDateOf(schedule.timezone, Math.max(afterMs, schedule.startAt - 1));
  let cursor = { year: start.year, month: start.month, day: start.day };
  for (let i = 0; i < 400; i += 1) {
    const parts = zonedParts(
      schedule.timezone,
      zonedLocalToUtc(schedule.timezone, cursor.year, cursor.month, cursor.day, 12, 0),
    );
    for (const utc of firesOnLocalDay(schedule, cursor.year, cursor.month, cursor.day, parts.weekday)) {
      if (utc > afterMs) return utc;
    }
    cursor = addLocalDays(cursor.year, cursor.month, cursor.day, 1);
    const dayStart = zonedLocalToUtc(schedule.timezone, cursor.year, cursor.month, cursor.day, 0, 0);
    if (dayStart >= schedule.endAt) return 0;
  }
  return 0;
}

export function nextFireAfter(schedule: Schedule, afterMs: number): number {
  switch (schedule.kind) {
    case 'daily':
    case 'weekday':
    case 'weekly':
      return nextCalendarFire(schedule, afterMs);
    case 'interval': {
      if (schedule.window) {
        const local = localDateOf(schedule.timezone, afterMs);
        let cursor = addLocalDays(local.year, local.month, local.day, -1);
        for (let i = 0; i < 400; i += 1) {
          for (const utc of intervalFiresOnStartDay(schedule, cursor.year, cursor.month, cursor.day)) {
            if (utc > afterMs) return utc;
          }
          cursor = addLocalDays(cursor.year, cursor.month, cursor.day, 1);
          const dayStart = zonedLocalToUtc(schedule.timezone, cursor.year, cursor.month, cursor.day, 0, 0);
          if (dayStart >= schedule.endAt + 24 * 3_600_000) return 0;
        }
        return 0;
      }
      if (afterMs < schedule.startAt) {
        return schedule.startAt < schedule.endAt ? schedule.startAt : 0;
      }
      const k = Math.floor((afterMs - schedule.startAt) / schedule.everyMs) + 1;
      const next = schedule.startAt + k * schedule.everyMs;
      return next < schedule.endAt ? next : 0;
    }
    case 'one-shot':
      return schedule.fireAt > afterMs && schedule.fireAt > 0 ? schedule.fireAt : 0;
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}

export function nextFires(schedule: Schedule, afterMs: number, count: number): number[] {
  const fires: number[] = [];
  let cursor = afterMs;
  for (let i = 0; i < count; i += 1) {
    const next = nextFireAfter(schedule, cursor);
    if (next === 0) break;
    fires.push(next);
    cursor = next;
  }
  return fires;
}

export interface CatchUpItem {
  id: number;
  paused: boolean;
  nextFireAt: number;
  lastFireAt: number;
  schedule: Schedule;
}

export function fireIsMissed(
  item: { paused: boolean; nextFireAt: number; lastFireAt: number },
  now: number,
): boolean {
  return !item.paused && item.nextFireAt > 0 && now > item.nextFireAt && item.lastFireAt < item.nextFireAt;
}

export function isMissed(item: CatchUpItem, now: number): boolean {
  return fireIsMissed(item, now);
}

export function planCatchUp(
  item: CatchUpItem,
  now: number,
): { run?: number; missedFires: number[] } {
  if (!isMissed(item, now)) return { missedFires: [] };
  const fires: number[] = [];
  let fireAt = item.nextFireAt;
  while (fireAt > 0 && fireAt < now) {
    if (fireAt > item.lastFireAt) fires.push(fireAt);
    fireAt = nextFireAfter(item.schedule, fireAt);
  }
  const eligible = fires.filter((instant) => now - instant <= CATCH_UP_WINDOW_MS);
  const run = eligible[eligible.length - 1];
  const missedFires = fires.filter((instant) => instant !== run);
  return run === undefined ? { missedFires } : { run, missedFires };
}

export function formatFireKey(id: number, fireAt: number): string {
  return `${id}@${fireAt}`;
}

export function parseFireKey(fireKey: string): { id: number; fireAt: number } | undefined {
  const at = fireKey.lastIndexOf('@');
  if (at <= 0) return undefined;
  const id = Number(fireKey.slice(0, at));
  const fireAt = Number(fireKey.slice(at + 1));
  if (!Number.isInteger(id) || id < 1 || !Number.isFinite(fireAt)) return undefined;
  return { id, fireAt };
}

/** Accept a persisted {@link Schedule} (the parse result, not the input form). */
export function readSchedule(value: unknown): Schedule | undefined {
  const rec = asRecord(value);
  if (!rec || typeof rec.kind !== 'string') return undefined;
  switch (rec.kind) {
    case 'one-shot': {
      if (typeof rec.fireAt !== 'number' || !Number.isFinite(rec.fireAt)) return undefined;
      return { kind: 'one-shot', fireAt: rec.fireAt };
    }
    case 'daily':
    case 'weekday': {
      if (typeof rec.timezone !== 'string' || !rec.timezone) return undefined;
      const times = readTimes(rec.times);
      if (!times || typeof rec.startAt !== 'number' || typeof rec.endAt !== 'number') return undefined;
      return rec.kind === 'daily'
        ? { kind: 'daily', timezone: rec.timezone, times, startAt: rec.startAt, endAt: rec.endAt }
        : { kind: 'weekday', timezone: rec.timezone, times, startAt: rec.startAt, endAt: rec.endAt };
    }
    case 'weekly': {
      if (typeof rec.timezone !== 'string' || !rec.timezone) return undefined;
      const times = readTimes(rec.times);
      if (!times || typeof rec.startAt !== 'number' || typeof rec.endAt !== 'number') return undefined;
      const weekdays = parseWeekdays(rec.weekdays);
      if (!weekdays) return undefined;
      return {
        kind: 'weekly',
        timezone: rec.timezone,
        weekdays,
        times,
        startAt: rec.startAt,
        endAt: rec.endAt,
      };
    }
    case 'interval': {
      if (typeof rec.timezone !== 'string' || !rec.timezone) return undefined;
      if (typeof rec.everyMs !== 'number' || !Number.isFinite(rec.everyMs)) return undefined;
      if (typeof rec.startAt !== 'number' || typeof rec.endAt !== 'number') return undefined;
      const window = rec.window === undefined ? undefined : parseWindow(rec.window);
      if (window === 'invalid') return undefined;
      return window
        ? { kind: 'interval', timezone: rec.timezone, everyMs: rec.everyMs, window, startAt: rec.startAt, endAt: rec.endAt }
        : { kind: 'interval', timezone: rec.timezone, everyMs: rec.everyMs, startAt: rec.startAt, endAt: rec.endAt };
    }
    default:
      return undefined;
  }
}

/** Year of the reminder 10-minute floor; valid schedules finish at or below this. */
export const EXACT_FIRE_COUNT_CAP = ONE_YEAR_MS / REMINDER_MIN_INTERVAL_MS;

function countFiresAfter(
  schedule: Schedule,
  afterMs: number,
  cap: number,
  untilExclusive?: number,
): { count: number; capped: boolean } {
  let count = 0;
  let cursor = afterMs;
  for (;;) {
    const next = nextFireAfter(schedule, cursor);
    if (next === 0 || (untilExclusive !== undefined && next >= untilExclusive)) {
      return { count, capped: false };
    }
    count += 1;
    if (count >= cap) {
      const more = nextFireAfter(schedule, next);
      const hasMore = more !== 0 && (untilExclusive === undefined || more < untilExclusive);
      return { count, capped: hasMore };
    }
    cursor = next;
  }
}

export function scheduleOccurrenceCount(
  schedule: Schedule,
  now: number,
): { count: number; capped: boolean } {
  return remainingFireCount(schedule, now, EXACT_FIRE_COUNT_CAP);
}

export function remainingFireCount(
  schedule: Schedule,
  now: number,
  cap: number,
): { count: number; capped: boolean } {
  switch (schedule.kind) {
    case 'one-shot':
      return countFiresAfter(schedule, now, cap);
    case 'daily':
    case 'weekday':
    case 'weekly':
    case 'interval':
      return countFiresAfter(schedule, Math.max(now, schedule.startAt) - 1, cap);
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}

export function monthlyFireCount(schedule: Schedule, fromMs: number): number {
  switch (schedule.kind) {
    case 'one-shot':
      return nextFireAfter(schedule, fromMs) === 0 ? 0 : 1;
    case 'daily':
    case 'weekday':
    case 'weekly':
    case 'interval': {
      const origin = Math.max(fromMs, schedule.startAt);
      const until = addLocalMonths(schedule.timezone, zonedParts(schedule.timezone, origin), 1);
      return countFiresAfter(schedule, origin - 1, EXACT_FIRE_COUNT_CAP, until).count;
    }
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}
