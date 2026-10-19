const WEEKDAY_SHORT: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: Monday = 1 … Sunday = 7. */
  weekday: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year
    && probe.getUTCMonth() + 1 === month
    && probe.getUTCDate() === day
  );
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    dtfFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function dtfFor(timeZone: string): Intl.DateTimeFormat {
  const cached = dtfCache.get(timeZone);
  if (cached) return cached;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  dtfCache.set(timeZone, dtf);
  return dtf;
}

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((entry) => entry.type === type)?.value ?? '';
}

export function zonedParts(timeZone: string, utcMs: number): ZonedParts {
  const parts = dtfFor(timeZone).formatToParts(new Date(utcMs));
  let hour = Number(part(parts, 'hour'));
  if (hour === 24) hour = 0;
  const weekdayName = part(parts, 'weekday');
  const weekday = WEEKDAY_SHORT[weekdayName];
  if (weekday === undefined) {
    throw new Error(`unexpected weekday token ${weekdayName}`);
  }
  return {
    year: Number(part(parts, 'year')),
    month: Number(part(parts, 'month')),
    day: Number(part(parts, 'day')),
    hour,
    minute: Number(part(parts, 'minute')),
    second: Number(part(parts, 'second')),
    weekday,
  };
}

function localKey(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
  return year * 1e10 + month * 1e8 + day * 1e6 + hour * 1e4 + minute * 100 + second;
}

function partsKey(parts: ZonedParts): number {
  return localKey(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
}

function matchesLocal(
  parts: ZonedParts,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): boolean {
  return (
    parts.year === year &&
    parts.month === month &&
    parts.day === day &&
    parts.hour === hour &&
    parts.minute === minute
  );
}

/** `localAsUtc - utc` at `utcMs`; EST (UTC−5) is −5h. */
function tzOffsetMs(timeZone: string, utcMs: number): number {
  const parts = zonedParts(timeZone, utcMs);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs;
}

function nextValidLocalMinute(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const target = localKey(year, month, day, hour, minute);
  const limit = Date.UTC(year, month - 1, day + 2) + 14 * 3_600_000;
  for (let utc = Date.UTC(year, month - 1, day) - 14 * 3_600_000; utc <= limit; utc += 60_000) {
    if (partsKey(zonedParts(timeZone, utc)) >= target) return utc;
  }
  return limit;
}

/**
 * UTC instant of a local wall time. A spring-forward gap shifts to the next
 * valid minute; a fall-back overlap uses the first occurrence.
 */
export function zonedLocalToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsets = new Set([
    tzOffsetMs(timeZone, localAsUtc - 36 * 3_600_000),
    tzOffsetMs(timeZone, localAsUtc),
    tzOffsetMs(timeZone, localAsUtc + 36 * 3_600_000),
  ]);
  const matches: number[] = [];
  for (const offset of offsets) {
    const utc = localAsUtc - offset;
    if (matchesLocal(zonedParts(timeZone, utc), year, month, day, hour, minute)) {
      matches.push(utc);
    }
  }
  if (matches.length > 0) return Math.min(...matches);
  return nextValidLocalMinute(timeZone, year, month, day, hour, minute);
}

export function addLocalDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const utc = Date.UTC(year, month - 1, day + days);
  const date = new Date(utc);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function addLocalMonths(
  timezone: string,
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  months: number,
): number {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return zonedLocalToUtc(timezone, year, month, Math.min(parts.day, lastDay), parts.hour, parts.minute);
}

export function addLocalCalendarDays(
  timezone: string,
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  days: number,
): number {
  const next = addLocalDays(parts.year, parts.month, parts.day, days);
  return zonedLocalToUtc(timezone, next.year, next.month, next.day, parts.hour, parts.minute);
}
