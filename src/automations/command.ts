import { reconcileDraftCard, sendAutomationDraftCard } from './draft-delivery';
import { sendManagedCard } from '../card/managed';
import { log } from '../core/logger';
import { senderTypeFromMessage } from '../bot/self-message';
import { classify, isNotInChat } from '../bot/feishu-error';
import { readCardApiError } from '../card/card-api-error';
import { abandonIfNotInChat } from './chat-lifecycle';
import type { CommandContext } from '../commands';
import { AUTO_CARD_TTL_MS, type AutoActionAuth, type AutoCardAction } from './action-auth';
import { draftCardBodyFromCard } from './card-body';
import {
  automationConfirmCard,
  automationDeleteCard,
  automationReplaceCard,
} from './confirm-card';
import { automationEndCard, type EndCardTokens, type EndPresetAction } from './end-card';
import {
  ONE_YEAR_MS,
  nextFireAfter,
  nextFires,
  parseSchedule,
  readSchedule,
  type LocalTime,
  type ParseScheduleResult,
  type PendingRecurring,
  type Schedule,
  type ScheduleRejectReason,
  type TaskType,
} from './schedule';
import { addLocalCalendarDays, addLocalDays, addLocalMonths, isValidCalendarDate, zonedLocalToUtc, zonedParts } from './zoned-time';
import { formatAutomationListLine } from './board-card';
import {
  draftConfirmedStatus,
  draftDeletedStatus,
  draftReplacedStatus,
  draftSameNameExistsStatus,
  draftTargetGoneStatus,
  draftTargetChangedStatus,
  DRAFT_SETTLED_CANCELLED,
} from './draft-card';
import { mutateAutomationTask, taskMutationLabels } from './task-mutation';
import { taskMutationError } from './store';
import type {
  AutomationDraft,
  AutomationItem,
  AutomationTaskType,
  AutomationsStore,
  DeleteAutomationDraft,
  ReplaceAutomationDraft,
} from './store';

export const AUTO_NEW_USAGE = '用法：`/auto new <时间表> | <名称> | <任务>`';
export const AUTO_P2P_HINT = '仅支持群';
export const AUTO_INVALID_HINT = '此确认已失效。';
export const AUTO_BOARD_UPDATED_HINT = '此看板已更新，请使用置顶的新看板。';
export const AUTO_LEAD_TOO_SOON = '最早 10 分钟后。';
export const AUTO_ONE_SHOT_TOO_FAR = '一次性任务不能超过 1 年。';
export const AUTO_AGENT_DISABLED = 'agent 任务未开启。';
export const AUTO_AGENT_NEEDS_CWD = '请先用 `/cd` 设置工作目录。';
export const AUTO_MISSING_END = '周期任务必须指定结束时间。';
export const AUTO_INTERVAL_TOO_SMALL = '间隔过短。';
export const AUTO_INVALID_SCHEDULE = '无法解析时间表。';
export const AUTO_INVALID_START =
  '无法识别开始时间。例如：从 明天 15:40 起 every 10m 15:40-16:05 until 2026-10-19 16:05';
export const AUTO_START_BEFORE_TODAY = '开始时间不能早于今天。';
export const AUTO_START_TOO_FAR = '开始时间不能超过 1 年。';
export const AUTO_END_NOT_AFTER_START = '结束时间必须晚于开始时间。';
export const AUTO_NO_REMAINING_FIRES = '结束前已没有可触发的时刻。';
export const AUTO_UNKNOWN_ID = '没有这个编号。';
export const AUTO_LIST_EMPTY = '暂无';
export const AUTO_INVALID_END = '无法解析结束时间。';
export const AUTO_END_BUSY = '该结束时间正在处理。';

export interface ParsedAutoNew {
  taskType: AutomationTaskType;
  scheduleText: string;
  name: string;
  taskText: string;
}

export function parseAutoNewArgs(args: string): ParsedAutoNew | { ok: false; reason: 'usage' } {
  const trimmed = args.trim();
  const match = trimmed.match(/^new(?:\s+(.*))?$/is);
  if (!match) return { ok: false, reason: 'usage' };
  let rest = (match[1] ?? '').trim();
  if (!rest) return { ok: false, reason: 'usage' };
  let taskType: AutomationTaskType = 'reminder';
  const agentPrefix = rest.match(/^agent(?:\s+|$)(.*)$/is);
  if (agentPrefix) {
    taskType = 'agent';
    rest = (agentPrefix[1] ?? '').trim();
  }
  const first = rest.indexOf('|');
  if (first < 0) return { ok: false, reason: 'usage' };
  const second = rest.indexOf('|', first + 1);
  if (second < 0) return { ok: false, reason: 'usage' };
  const scheduleText = rest.slice(0, first).trim();
  const name = rest.slice(first + 1, second).trim();
  const taskText = rest.slice(second + 1).trim();
  if (!scheduleText || !name || !taskText) return { ok: false, reason: 'usage' };
  return { taskType, scheduleText, name, taskText };
}

export type ScheduleTextRejectReason =
  | ScheduleRejectReason
  | 'past-time'
  | 'invalid-start'
  | 'start-before-today'
  | 'start-too-far'
  | 'end-not-after-start'
  | 'no-remaining-fires';

export type AutomationRejectSource = 'command' | 'confirmation';

export type AutomationScheduleVerdict =
  | { outcome: 'confirm'; schedule: Schedule }
  | { outcome: 'needs-end'; pending: PendingRecurring; startAt?: number }
  | { outcome: 'reject'; reason: ScheduleTextRejectReason; clock?: string }
  | { outcome: 'refuse'; message: string };

/** Text schedules remain supported by manual commands and stored confirmation drafts. */
export function assessAutomationSchedule(input: {
  taskType: AutomationTaskType;
  scheduleText: string;
  now: number;
  timezone: string;
  hasCwd: boolean;
}): AutomationScheduleVerdict {
  const parsed = parseScheduleText(input.scheduleText, {
    taskType: input.taskType,
    now: input.now,
    timezone: input.timezone,
  });
  if (!parsed.ok) {
    if (parsed.reason !== 'missing-end-at' || !parsed.pending) {
      return {
        outcome: 'reject',
        reason: parsed.reason,
        ...(parsed.clock !== undefined ? { clock: parsed.clock } : {}),
      };
    }
    if (input.taskType === 'agent' && !input.hasCwd) {
      return { outcome: 'refuse', message: AUTO_AGENT_NEEDS_CWD };
    }
    return {
      outcome: 'needs-end',
      pending: parsed.pending,
      ...(parsed.startAt !== undefined ? { startAt: parsed.startAt } : {}),
    };
  }
  if (!hasRemainingFire(parsed.schedule, input.now)) {
    return { outcome: 'reject', reason: 'no-remaining-fires' };
  }
  if (input.taskType === 'agent' && !input.hasCwd) {
    return { outcome: 'refuse', message: AUTO_AGENT_NEEDS_CWD };
  }
  return { outcome: 'confirm', schedule: parsed.schedule };
}

function hasRemainingFire(schedule: Schedule, now: number): boolean {
  return nextFires(schedule, now, 1).length > 0;
}

export function noteAutomationRejected(
  reason: ScheduleTextRejectReason,
  source: AutomationRejectSource,
): void {
  log.info('auto', 'rejected', {
    reason: rejectLogReason(reason),
    source,
  });
}

export type ParseScheduleTextResult =
  | { ok: true; schedule: Schedule }
  | {
      ok: false;
      reason: ScheduleTextRejectReason;
      pending?: PendingRecurring;
      startAt?: number;
      clock?: string;
    };

export function parseScheduleText(
  text: string,
  options: { taskType: TaskType; now: number; timezone: string },
): ParseScheduleTextResult {
  const trimmed = text.trim();
  const relative = parseRelative(trimmed, options.now);
  if (relative !== undefined) {
    return parseSchedule({ kind: 'one-shot', fireAt: relative }, options);
  }
  const absolute = parseAbsolute(trimmed, options.timezone);
  if (absolute !== undefined) {
    return parseSchedule({ kind: 'one-shot', fireAt: absolute }, options);
  }
  const named = parseNamedDayTime(trimmed, options);
  if (named) {
    if (!named.ok) return named;
    return parseSchedule({ kind: 'one-shot', fireAt: named.fireAt }, options);
  }
  const bare = parseBareClock(trimmed, options);
  if (bare) {
    return parseSchedule({ kind: 'one-shot', fireAt: bare.fireAt }, options);
  }
  return parseRecurringText(trimmed, options);
}

export function completePendingSchedule(
  pending: PendingRecurring,
  endAt: number,
  options: { taskType: TaskType; now: number; startAt?: number },
): ParseScheduleResult {
  return parseSchedule({
    kind: pending.kind,
    timezone: pending.timezone,
    ...(pending.times ? { times: pending.times } : {}),
    ...(pending.weekdays ? { weekdays: pending.weekdays } : {}),
    ...(pending.every ? { every: pending.every } : {}),
    ...(pending.window ? { window: pending.window } : {}),
    startAt: options.startAt ?? options.now,
    endAt,
  }, options);
}

export function parseEndAtText(text: string, timezone: string): number | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return undefined;
  if (match[4] !== undefined) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    if (hour > 23 || minute > 59) return undefined;
    return zonedLocalToUtc(timezone, year, month, day, hour, minute);
  }
  const next = addLocalDays(year, month, day, 1);
  return zonedLocalToUtc(timezone, next.year, next.month, next.day, 0, 0);
}

export function presetEndAt(
  action: EndPresetAction,
  timezone: string,
  now: number,
  startAt = now,
): number {
  const parts = zonedParts(timezone, startAt);
  switch (action) {
    case 'auto.end.1w':
      return addLocalCalendarDays(timezone, parts, 7);
    case 'auto.end.2w':
      return addLocalCalendarDays(timezone, parts, 14);
    case 'auto.end.1m':
      return addLocalMonths(timezone, parts, 1);
    case 'auto.end.3m':
      return addLocalMonths(timezone, parts, 3);
    case 'auto.end.eoy':
      return zonedLocalToUtc(timezone, parts.year + 1, 1, 1, 0, 0);
    case 'auto.end.1y':
      return startAt + ONE_YEAR_MS;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function parseRelative(text: string, now: number): number | undefined {
  const trimmed = text.trim();
  const patterns: Array<{ re: RegExp; ms: (n: number) => number }> = [
    { re: /^in\s+(\d+)\s*(m|min|mins|minute|minutes)$/i, ms: (n) => n * 60_000 },
    { re: /^in\s+(\d+)\s*(h|hr|hrs|hour|hours)$/i, ms: (n) => n * 3_600_000 },
    { re: /^(\d+)\s*(m|min|mins|分钟)后?$/i, ms: (n) => n * 60_000 },
    { re: /^(\d+)\s*(h|hr|hrs|hour|hours|小时)后?$/i, ms: (n) => n * 3_600_000 },
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern.re);
    if (!match) continue;
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1) return undefined;
    return now + pattern.ms(n);
  }
  return undefined;
}

function parseAbsolute(text: string, timezone: string): number | undefined {
  const trimmed = text.trim().replace(/^at\s+/i, '');
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!isValidCalendarDate(year, month, day) || hour > 23 || minute > 59) return undefined;
  return zonedLocalToUtc(timezone, year, month, day, hour, minute);
}

function parseRecurringText(
  text: string,
  options: { taskType: TaskType; now: number; timezone: string },
): ParseScheduleTextResult {
  const prefix = parseStartPrefix(text, options.timezone, options.now);
  if (prefix && !prefix.ok) return { ok: false, reason: prefix.reason };
  const startAt = prefix ? prefix.startAt : options.now;
  const source = prefix ? prefix.rest : text;
  const { body, endText } = splitEndSuffix(source);
  const pending = parsePendingRecurring(body, options.timezone);
  if (!pending) return { ok: false, reason: 'invalid-schedule' };

  const probe = completePendingSchedule(pending, startAt + 30 * 24 * 60 * 60_000, {
    taskType: options.taskType,
    now: options.now,
    startAt,
  });
  if (!probe.ok && probe.reason !== 'missing-end-at' && probe.reason !== 'recurring-too-long') {
    return { ok: false, reason: probe.reason };
  }

  if (endText === undefined) {
    return prefix
      ? { ok: false, reason: 'missing-end-at', pending, startAt }
      : { ok: false, reason: 'missing-end-at', pending };
  }
  const endAt = parseEndAtText(endText, options.timezone);
  if (endAt === undefined) return { ok: false, reason: 'invalid-schedule' };
  if (endAt <= startAt) return { ok: false, reason: 'end-not-after-start' };
  return completePendingSchedule(pending, endAt, {
    taskType: options.taskType,
    now: options.now,
    startAt,
  });
}

const DAY_OFFSET: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2 };

function parseNamedDayTime(
  text: string,
  options: { now: number; timezone: string },
): { ok: true; fireAt: number } | { ok: false; reason: 'past-time' | 'invalid-schedule'; clock?: string } | undefined {
  const match = text.match(/^(今天|明天|后天)\s+(\d{1,2})[:：](\d{2})$/);
  if (!match) return undefined;
  const day = match[1]!;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour > 23 || minute > 59) return { ok: false, reason: 'invalid-schedule' };
  const offset = DAY_OFFSET[day];
  if (offset === undefined) return { ok: false, reason: 'invalid-schedule' };
  const date = shiftLocalDate(options.timezone, options.now, offset);
  const fireAt = zonedLocalToUtc(options.timezone, date.year, date.month, date.day, hour, minute);
  if (day === '今天' && fireAt <= options.now) {
    return { ok: false, reason: 'past-time', clock: formatClock(hour, minute) };
  }
  return { ok: true, fireAt };
}

function parseBareClock(
  text: string,
  options: { now: number; timezone: string },
): { ok: true; fireAt: number } | undefined {
  const clock = parseClock(text);
  if (!clock) return undefined;
  const today = shiftLocalDate(options.timezone, options.now, 0);
  const todayAt = zonedLocalToUtc(
    options.timezone,
    today.year,
    today.month,
    today.day,
    clock.hour,
    clock.minute,
  );
  if (todayAt > options.now) return { ok: true, fireAt: todayAt };
  const tomorrow = shiftLocalDate(options.timezone, options.now, 1);
  return {
    ok: true,
    fireAt: zonedLocalToUtc(
      options.timezone,
      tomorrow.year,
      tomorrow.month,
      tomorrow.day,
      clock.hour,
      clock.minute,
    ),
  };
}

type StartPrefix =
  | { ok: true; startAt: number; rest: string }
  | { ok: false; reason: 'invalid-start' | 'start-before-today' | 'start-too-far' };

function parseStartPrefix(text: string, timezone: string, now: number): StartPrefix | undefined {
  const zh = text.match(
    /^从\s+(今天|明天|后天|\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}[:：]\d{2}))?\s+起\s+(.+)$/,
  );
  const en = text.match(/^from\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}[:：]\d{2}))?\s+(.+)$/i);
  const match = zh ?? en;
  if (!match) {
    if (/^从(?:\s|$)/.test(text) || /^from(?:\s|$)/i.test(text)) {
      return { ok: false, reason: 'invalid-start' };
    }
    return undefined;
  }
  const dateToken = match[1]!;
  const clockToken = match[2];
  const rest = match[3]!.trim();
  if (!rest) return { ok: false, reason: 'invalid-start' };
  const date = resolveStartDate(dateToken, timezone, now);
  if (!date) return { ok: false, reason: 'invalid-start' };
  if (dateKey(date) < dateKey(localDate(timezone, now))) {
    return { ok: false, reason: 'start-before-today' };
  }
  const clock = clockToken ? parseClock(clockToken) : { hour: 0, minute: 0 };
  if (!clock) return { ok: false, reason: 'invalid-start' };
  const startAt = zonedLocalToUtc(timezone, date.year, date.month, date.day, clock.hour, clock.minute);
  if (startAt - now > ONE_YEAR_MS) return { ok: false, reason: 'start-too-far' };
  return { ok: true, startAt, rest };
}

function resolveStartDate(
  token: string,
  timezone: string,
  now: number,
): { year: number; month: number; day: number } | undefined {
  const offset = DAY_OFFSET[token];
  if (offset !== undefined) return shiftLocalDate(timezone, now, offset);
  const match = token.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return undefined;
  return { year, month, day };
}

function parseClock(text: string): { hour: number; minute: number } | undefined {
  const match = text.match(/^(\d{1,2})[:：](\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function localDate(timezone: string, utcMs: number): { year: number; month: number; day: number } {
  const parts = zonedParts(timezone, utcMs);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function shiftLocalDate(
  timezone: string,
  utcMs: number,
  days: number,
): { year: number; month: number; day: number } {
  const today = localDate(timezone, utcMs);
  return addLocalDays(today.year, today.month, today.day, days);
}

function dateKey(date: { year: number; month: number; day: number }): number {
  return date.year * 10_000 + date.month * 100 + date.day;
}

function splitEndSuffix(text: string): { body: string; endText?: string } {
  const match = text.trim().match(/^(.*?)\s+(?:until|到|结束)\s+(.+)$/i);
  if (!match) return { body: text.trim() };
  return { body: match[1]!.trim(), endText: match[2]!.trim() };
}

function parsePendingRecurring(text: string, timezone: string): PendingRecurring | undefined {
  const trimmed = text.trim();
  const interval = trimmed.match(
    /^(?:every|每)\s*(\d+)\s*(m|min|mins|minute|minutes|分钟|h|hr|hrs|hour|hours|小时)(?:\s+(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2}))?$/i,
  );
  if (interval) {
    const n = Number(interval[1]);
    if (!Number.isInteger(n) || n < 1) return undefined;
    const unit = isHourUnit(interval[2]!) ? 'hours' : 'minutes';
    const window = interval[3] && interval[4]
      ? parseWindowTimes(interval[3], interval[4])
      : undefined;
    if (interval[3] && !window) return undefined;
    return window
      ? { kind: 'interval', timezone, every: { unit, n }, window }
      : { kind: 'interval', timezone, every: { unit, n } };
  }

  const weekday = trimmed.match(/^(?:weekday|每个工作日|工作日)\s*(.+)$/i);
  if (weekday) {
    const times = parseTimes(weekday[1]!);
    if (!times) return undefined;
    return { kind: 'weekday', timezone, times };
  }

  const daily = trimmed.match(/^(?:daily|每天)\s*(.+)$/i);
  if (daily) {
    const times = parseTimes(daily[1]!);
    if (!times) return undefined;
    return { kind: 'daily', timezone, times };
  }

  const weekly = trimmed.match(/^(?:weekly|每周)\s*(.+)$/i);
  if (weekly) {
    const parsed = parseWeeklyRest(weekly[1]!);
    if (!parsed) return undefined;
    return { kind: 'weekly', timezone, weekdays: parsed.weekdays, times: parsed.times };
  }
  return undefined;
}

function isHourUnit(unit: string): boolean {
  return /^(h|hr|hrs|hour|hours|小时)$/i.test(unit);
}

function parseTimes(text: string): LocalTime[] | undefined {
  const parts = text.split(/[,、]\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const times: LocalTime[] = [];
  for (const part of parts) {
    const match = part.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return undefined;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return undefined;
    times.push({ hour, minute });
  }
  return times;
}

function parseWindowTimes(fromText: string, toText: string): { from: LocalTime; to: LocalTime } | undefined {
  const from = parseTimes(fromText)?.[0];
  const to = parseTimes(toText)?.[0];
  if (!from || !to) return undefined;
  if (from.hour === to.hour && from.minute === to.minute) return undefined;
  return { from, to };
}

function parseWeeklyRest(text: string): { weekdays: number[]; times: LocalTime[] } | undefined {
  const match = text.trim().match(/^(.*?)\s+((?:\d{1,2}:\d{2})(?:\s*[,、]\s*\d{1,2}:\d{2})*)$/);
  if (!match) return undefined;
  const weekdays = parseWeekdayList(match[1]!);
  const times = parseTimes(match[2]!);
  if (!weekdays || !times) return undefined;
  return { weekdays, times };
}

const WEEKDAY_TOKENS: Record<string, number> = {
  1: 1, 一: 1, 周一: 1, 星期一: 1, mon: 1, monday: 1,
  2: 2, 二: 2, 周二: 2, 星期二: 2, tue: 2, tues: 2, tuesday: 2,
  3: 3, 三: 3, 周三: 3, 星期三: 3, wed: 3, wednesday: 3,
  4: 4, 四: 4, 周四: 4, 星期四: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  5: 5, 五: 5, 周五: 5, 星期五: 5, fri: 5, friday: 5,
  6: 6, 六: 6, 周六: 6, 星期六: 6, sat: 6, saturday: 6,
  7: 7, 日: 7, 天: 7, 周日: 7, 周天: 7, 星期日: 7, 星期天: 7, sun: 7, sunday: 7,
};

function parseWeekdayList(text: string): number[] | undefined {
  const parts = text.split(/[,、]\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const days: number[] = [];
  for (const part of parts) {
    const day = WEEKDAY_TOKENS[part.toLowerCase()];
    if (day === undefined) return undefined;
    if (!days.includes(day)) days.push(day);
  }
  days.sort((a, b) => a - b);
  return days;
}

export function rejectMessage(
  reason: ScheduleTextRejectReason,
  detail?: { clock?: string },
): string {
  switch (reason) {
    case 'lead-too-soon':
      return AUTO_LEAD_TOO_SOON;
    case 'past-time': {
      const clock = detail?.clock ?? 'HH:MM';
      return `今天 ${clock} 已过，可改为「明天 ${clock}」。`;
    }
    case 'one-shot-too-far':
      return AUTO_ONE_SHOT_TOO_FAR;
    case 'start-too-far':
      return AUTO_START_TOO_FAR;
    case 'missing-end-at':
      return AUTO_MISSING_END;
    case 'interval-too-small':
      return AUTO_INTERVAL_TOO_SMALL;
    case 'invalid-start':
      return AUTO_INVALID_START;
    case 'start-before-today':
      return AUTO_START_BEFORE_TODAY;
    case 'end-not-after-start':
      return AUTO_END_NOT_AFTER_START;
    case 'no-remaining-fires':
      return AUTO_NO_REMAINING_FIRES;
    case 'invalid-timezone':
    case 'recurring-too-long':
    case 'invalid-schedule':
      return AUTO_INVALID_SCHEDULE;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function rejectLogReason(reason: ScheduleTextRejectReason): string {
  switch (reason) {
    case 'lead-too-soon':
      return 'below-floor';
    case 'past-time':
      return 'past-time';
    case 'one-shot-too-far':
    case 'start-too-far':
    case 'recurring-too-long':
      return 'too-far';
    case 'invalid-start':
    case 'start-before-today':
      return 'invalid-start';
    case 'end-not-after-start':
    case 'invalid-schedule':
    case 'invalid-timezone':
      return 'invalid-schedule';
    case 'no-remaining-fires':
      return 'no-remaining-fires';
    case 'missing-end-at':
      return 'missing-end-at';
    case 'interval-too-small':
      return 'interval-too-small';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export type AutomationCommandContext = Pick<
  CommandContext,
  | 'channel'
  | 'msg'
  | 'scope'
  | 'chatMode'
  | 'workspaces'
  | 'automations'
  | 'autoAuth'
  | 'automationsScheduler'
  | 'now'
  | 'controls'
  | 'isLinkDown'
>;

export type ParsedAutoCommand =
  | ParsedAutoNew & { op: 'new' }
  | { op: 'list' }
  | { op: 'pause' | 'resume' | 'delete'; id: number }
  | { op: 'usage' };

export function parseAutoCommand(args: string): ParsedAutoCommand {
  const trimmed = args.trim();
  if (!trimmed || /^list$/i.test(trimmed)) return { op: 'list' };
  const mutate = trimmed.match(/^(pause|resume|delete)\s+(\d+)$/i);
  if (mutate) {
    const id = Number(mutate[2]);
    if (!Number.isInteger(id) || id < 1) return { op: 'usage' };
    const op = mutate[1]!.toLowerCase();
    if (op !== 'pause' && op !== 'resume' && op !== 'delete') return { op: 'usage' };
    return { op, id };
  }
  const parsed = parseAutoNewArgs(trimmed);
  if ('ok' in parsed) return { op: 'usage' };
  return { op: 'new', ...parsed };
}

export async function handleAutoCommand(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.controls.profileConfig.automations.enabled) return;
  if (isIgnoredAutoSender(ctx)) return;
  if (ctx.scope.startsWith('auto:') || ctx.scope.startsWith('meeting:')) return;
  if (ctx.chatMode === 'p2p' || ctx.msg.chatType === 'p2p') {
    await replyAuto(ctx, AUTO_P2P_HINT);
    return;
  }

  const parsed = parseAutoCommand(args);
  switch (parsed.op) {
    case 'list':
      await listAutos(ctx);
      return;
    case 'pause':
    case 'resume':
    case 'delete':
      await mutateAuto(ctx, parsed.op, parsed.id);
      return;
    case 'usage':
      await replyAuto(ctx, AUTO_NEW_USAGE);
      return;
    case 'new':
      await submitAutomationCommand(ctx, parsed);
      return;
    default: {
      const _exhaustive: never = parsed;
      return _exhaustive;
    }
  }
}

export async function submitAutomationCommand(
  ctx: AutomationCommandContext,
  parsed: ParsedAutoNew,
  source: AutomationRejectSource = 'command',
): Promise<void> {
  if (!ctx.controls.profileConfig.automations.enabled) return;
  if (isIgnoredAutoSender(ctx)) return;
  if (ctx.scope.startsWith('auto:') || ctx.scope.startsWith('meeting:')) return;
  if (ctx.chatMode === 'p2p' || ctx.msg.chatType === 'p2p') {
    await replyAuto(ctx, AUTO_P2P_HINT);
    return;
  }

  if (parsed.taskType === 'agent' && !ctx.controls.profileConfig.automations.agentTasks) {
    await replyAuto(ctx, AUTO_AGENT_DISABLED);
    return;
  }

  if (!ctx.automations || !ctx.autoAuth) {
    await replyAuto(ctx, AUTO_NEW_USAGE);
    return;
  }

  const now = (ctx.now ?? Date.now)();
  const timezone = ctx.controls.profileConfig.automations.timezone;
  const cwd = parsed.taskType === 'agent'
    ? ctx.workspaces.cwdFor(ctx.scope) ?? ctx.controls.profileConfig.workspaces.default
    : undefined;
  const verdict = assessAutomationSchedule({
    taskType: parsed.taskType,
    scheduleText: parsed.scheduleText,
    now,
    timezone,
    hasCwd: typeof cwd === 'string' && cwd.trim().length > 0,
  });
  switch (verdict.outcome) {
    case 'refuse':
      await replyAuto(ctx, verdict.message);
      return;
    case 'reject':
      noteAutomationRejected(verdict.reason, source);
      await replyAuto(ctx, rejectMessage(verdict.reason, verdict));
      return;
    case 'needs-end': {
      const draft = await ctx.automations.saveDraft({
        taskType: parsed.taskType,
        schedule: verdict.pending,
        timezone,
        startAt: verdict.startAt ?? now,
        nextFireAt: 0,
        chatId: ctx.msg.chatId,
        createdBy: ctx.msg.senderId,
        name: parsed.name,
        taskText: parsed.taskText,
        pendingRecurring: verdict.pending,
        ...(cwd ? { cwd } : {}),
      });
      if (!ctx.isLinkDown?.()) await postEndCard(ctx, draft);
      if (ctx.automations.getDraft(draft.draftId)) {
        log.info('auto', 'draft', {
          draftId: draft.draftId,
          taskType: parsed.taskType,
          chatId: ctx.msg.chatId,
          waiting: 'end',
        });
      }
      return;
    }
    case 'confirm': {
      const nextFireAt = nextFireAfter(verdict.schedule, now);
      const startAt = scheduleStartAt(verdict.schedule, now);
      const endAt = scheduleEndAt(verdict.schedule);
      const draft = await ctx.automations.saveDraft({
        taskType: parsed.taskType,
        schedule: verdict.schedule,
        timezone,
        startAt,
        ...(endAt !== undefined ? { endAt } : {}),
        nextFireAt,
        chatId: ctx.msg.chatId,
        createdBy: ctx.msg.senderId,
        name: parsed.name,
        taskText: parsed.taskText,
        ...(cwd ? { cwd } : {}),
      });
      if (!ctx.isLinkDown?.()) {
        await postConfirmCard(ctx, draft, verdict.schedule, now, ctx.msg.messageId);
      }
      if (ctx.automations.getDraft(draft.draftId)) {
        log.info('auto', 'draft', {
          draftId: draft.draftId,
          taskType: parsed.taskType,
          chatId: ctx.msg.chatId,
        });
      }
      return;
    }
    default: {
      const _exhaustive: never = verdict;
      return _exhaustive;
    }
  }
}

export type DraftFlushContext = {
  botAppId?: string;
  channel: CommandContext['channel'];
  automations?: AutomationsStore;
  autoAuth?: AutoActionAuth;
  automationsScheduler?: CommandContext['automationsScheduler'];
  now?: () => number;
  isLinkDown?: () => boolean;
};

/** In-flight card claim per draft. Bind happens after send, so a second flush must wait. */
const draftCardClaims = new Map<string, Promise<void>>();

export async function flushPendingDraftCards(ctx: DraftFlushContext): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth || ctx.isLinkDown?.()) return;
  const now = (ctx.now ?? Date.now)();
  for (const draft of ctx.automations.listDrafts()) {
    if (draft.cardMessageId) continue;
    try {
      await flushDraftCardOnce(ctx, draft.draftId, now);
    } catch (error) {
      log.fail('auto', error, { event: 'draft.flush', draftId: draft.draftId });
    }
  }
}

export async function flushDraftCardOnce(ctx: DraftFlushContext, draftId: string, now: number): Promise<void> {
  const automations = ctx.automations;
  if (!automations || !ctx.autoAuth || ctx.isLinkDown?.()) return;
  for (;;) {
    const inflight = draftCardClaims.get(draftId);
    if (inflight) {
      await inflight;
      continue;
    }
    const draft = automations.getDraft(draftId);
    if (!draft || draft.cardMessageId) return;
    if (draft.delivery?.state === 'sending') { await reconcileDraftCard(ctx.channel, automations, draft, ctx.botAppId); return; }
    if (draft.operationId && draft.delivery?.state === 'rejected') return;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    draftCardClaims.set(draftId, gate);
    try {
      await deliverUnboundDraftCard(ctx, draft, now);
    } finally {
      if (draftCardClaims.get(draftId) === gate) draftCardClaims.delete(draftId);
      release();
    }
    return;
  }
}

async function deliverUnboundDraftCard(
  ctx: DraftFlushContext,
  draft: AutomationDraft,
  now: number,
): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth) return;
  const cardCtx = {
    channel: ctx.channel,
    automations: ctx.automations,
    autoAuth: ctx.autoAuth,
    automationsScheduler: ctx.automationsScheduler,
    chatMode: draft.cardReply?.replyInThread ? 'topic' as const : 'group' as const,
    msg: { chatId: draft.chatId, messageId: draft.cardReply?.replyTo ?? '', threadId: draft.cardReply?.threadId },
  };
  switch (draft.op) {
    case 'delete':
      await postDeleteCard(cardCtx, draft);
      return;
    case 'create':
    case 'replace':
      if (draft.pendingRecurring) {
        await postEndCard(cardCtx, draft);
        return;
      }
      {
        const schedule = readSchedule(draft.schedule);
        if (!schedule) return;
        await postConfirmCard(cardCtx, draft, schedule, now, cardCtx.msg.messageId);
      }
      return;
    default: {
      const _exhaustive: never = draft;
      return _exhaustive;
    }
  }
}

export async function completeDraftEnd(
  ctx: {
    automations: AutomationsStore;
    autoAuth: AutoActionAuth;
    automationsScheduler?: CommandContext['automationsScheduler'];
    channel: CommandContext['channel'];
    now?: () => number;
    chatMode?: CommandContext['chatMode'];
  },
  draft: Exclude<AutomationDraft, DeleteAutomationDraft>,
  endAt: number,
  replyTo: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const pending = draft.pendingRecurring;
  if (!pending) return { ok: false, message: AUTO_INVALID_HINT };
  if (endAt <= draft.startAt) return { ok: false, message: AUTO_END_NOT_AFTER_START };
  const now = (ctx.now ?? Date.now)();
  const parsed = completePendingSchedule(pending, endAt, {
    taskType: draft.taskType,
    now,
    startAt: draft.startAt,
  });
  if (!parsed.ok) return { ok: false, message: rejectMessage(parsed.reason) };
  if (!hasRemainingFire(parsed.schedule, now)) {
    return { ok: false, message: rejectMessage('no-remaining-fires') };
  }
  // A second tap on this end card is still queued behind this await. Leave
  // the binding in place until it can lose the nonce check, then drop the
  // end card before the confirm send so a link failure can be retried.
  await Promise.resolve();
  const nextFireAt = nextFireAfter(parsed.schedule, now);
  const updated = await ctx.automations.updateDraft(draft.draftId, {
    schedule: parsed.schedule,
    endAt,
    nextFireAt,
    pendingRecurring: null,
    cardMessageId: null,
    ...(draft.operationId || draft.cardReply ? { cardReply: { ...(draft.cardReply ?? {}), replyTo } } : {}),
  });
  if (!updated || updated.op === 'delete') return { ok: false, message: AUTO_INVALID_HINT };
  if (updated.operationId) {
    await flushDraftCardOnce(ctx, updated.draftId, now);
    return { ok: true };
  }
  await postConfirmCard({
    channel: ctx.channel,
    automations: ctx.automations,
    autoAuth: ctx.autoAuth,
    automationsScheduler: ctx.automationsScheduler,
    chatMode: updated.cardReply?.replyInThread ? 'topic' : ctx.chatMode ?? 'group',
    msg: { chatId: draft.chatId, threadId: updated.cardReply?.threadId },
  }, updated, parsed.schedule, now, replyTo);
  return { ok: true };
}

export function resolveEndAt(
  action: AutoCardAction,
  input: { timezone: string; now: number; startAt?: number; customText?: string },
): number | undefined {
  switch (action) {
    case 'auto.end.1w':
    case 'auto.end.2w':
    case 'auto.end.1m':
    case 'auto.end.3m':
    case 'auto.end.eoy':
    case 'auto.end.1y':
      return presetEndAt(action, input.timezone, input.now, input.startAt ?? input.now);
    case 'auto.end.custom':
      return input.customText ? parseEndAtText(input.customText, input.timezone) : undefined;
    case 'auto.confirm':
    case 'auto.reject':
      return undefined;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export interface AutomationConfirmOutcome {
  ok: boolean;
  status: string;
  toast: string;
}

export async function confirmAutomationDraft(
  ctx: Pick<CommandContext, 'automations' | 'automationsScheduler' | 'onAutomationConfirmed'> & {
    now?: () => number;
  },
  draft: AutomationDraft,
): Promise<AutomationConfirmOutcome> {
  if (draft.op !== 'create' && ctx.automations) {
    const code = taskMutationError(ctx.automations.get(draft.targetId), { chatId: draft.chatId, revision: draft.target.revision });
    if (code) {
      const status = code === 'target-not-found' ? draftTargetGoneStatus(draft.targetId) : draftTargetChangedStatus(draft.targetId);
      if (draft.operationId) await ctx.automations.rejectOperation(draft.operationId, code, status);
      return { ok: false, status, toast: status };
    }
  }
  switch (draft.op) {
    case 'create':
      return confirmCreateDraft(ctx, draft);
    case 'delete':
      return confirmDeleteDraft(ctx, draft);
    case 'replace':
      return confirmReplaceDraft(ctx, draft);
    default: {
      const _exhaustive: never = draft;
      return _exhaustive;
    }
  }
}

async function confirmCreateDraft(
  ctx: Pick<CommandContext, 'automations' | 'onAutomationConfirmed'>,
  draft: Exclude<AutomationDraft, DeleteAutomationDraft | ReplaceAutomationDraft>,
): Promise<AutomationConfirmOutcome> {
  if (!ctx.automations || draft.pendingRecurring) return confirmInvalid();
  const conflict = findSameNameCreateConflict(ctx.automations, draft);
  if (conflict) {
    const status = draftSameNameExistsStatus(conflict.id);
    if (draft.operationId) await ctx.automations.rejectOperation(draft.operationId, 'same-name-confirmed', status);
    return { ok: false, status, toast: status };
  }
  const item = await ctx.automations.create({
    ...(draft.operationId ? { operationId: draft.operationId } : {}),
    taskType: draft.taskType,
    schedule: draft.schedule,
    timezone: draft.timezone,
    startAt: draft.startAt,
    ...(draft.endAt !== undefined ? { endAt: draft.endAt } : {}),
    nextFireAt: draft.nextFireAt,
    chatId: draft.chatId,
    createdBy: draft.createdBy,
    name: draft.name,
    taskText: draft.taskText,
    ...(draft.cwd ? { cwd: draft.cwd } : {}),
  });
  log.info('auto', 'confirmed', { id: item.id, taskType: item.taskType, chatId: item.chatId });
  scheduleAutomationConfirmed(ctx.onAutomationConfirmed, item);
  const status = draftConfirmedStatus(item.id);
  return { ok: true, status, toast: status };
}

async function confirmDeleteDraft(
  ctx: Pick<CommandContext, 'automations' | 'automationsScheduler'>,
  draft: DeleteAutomationDraft,
): Promise<AutomationConfirmOutcome> {
  if (!ctx.automations || !ctx.automationsScheduler) return confirmInvalid();
  const item = ctx.automations.get(draft.targetId);
  if (!item || item.chatId !== draft.chatId) {
    const status = draftTargetGoneStatus(draft.targetId);
    return { ok: false, status, toast: status };
  }
  const ok = await ctx.automationsScheduler.delete(draft.targetId, { chatId: draft.chatId, revision: draft.target.revision, operationId: draft.operationId });
  if (!ok) {
    const code = taskMutationError(ctx.automations.get(draft.targetId), { chatId: draft.chatId, revision: draft.target.revision }) ?? 'target-not-found';
    const status = code === 'target-state-conflict' ? draftTargetChangedStatus(draft.targetId) : draftTargetGoneStatus(draft.targetId);
    if (draft.operationId) await ctx.automations.rejectOperation(draft.operationId, code, status);
    return { ok: false, status, toast: status };
  }
  log.info('auto', 'deleted', { id: draft.targetId, source: 'confirmation' });
  const status = draftDeletedStatus(draft.targetId);
  return { ok: true, status, toast: status };
}

async function confirmReplaceDraft(
  ctx: Pick<CommandContext, 'automations' | 'automationsScheduler' | 'onAutomationConfirmed'> & {
    now?: () => number;
  },
  draft: ReplaceAutomationDraft,
): Promise<AutomationConfirmOutcome> {
  if (!ctx.automations || !ctx.automationsScheduler || draft.pendingRecurring) return confirmInvalid();
  const now = (ctx.now ?? Date.now)();
  const blocked = replaceConfirmBlock(draft, now);
  if (blocked.outcome !== 'confirm') {
    if (blocked.outcome === 'reject') noteAutomationRejected(blocked.reason, 'confirmation');
    const message = blocked.outcome === 'reject'
      ? rejectMessage(blocked.reason, blocked)
      : blocked.outcome === 'refuse'
        ? blocked.message
        : AUTO_INVALID_HINT;
    if (draft.operationId) await ctx.automations.rejectOperation(draft.operationId, blocked.outcome === 'reject' ? blocked.reason : 'confirmation-invalid', message);
    return { ok: false, status: message, toast: message };
  }
  let created: AutomationItem | undefined;
  try {
    const nextFireAt = nextFireAfter(blocked.schedule, now);
    const startAt = scheduleStartAt(blocked.schedule, now);
    const endAt = scheduleEndAt(blocked.schedule);
    created = await ctx.automations.replace(draft, {
      taskType: draft.taskType,
      schedule: blocked.schedule,
      timezone: draft.timezone,
      startAt,
      ...(endAt !== undefined ? { endAt } : {}),
      nextFireAt,
      chatId: draft.chatId,
      createdBy: draft.createdBy,
      name: draft.name,
      taskText: draft.taskText,
      ...(draft.cwd ? { cwd: draft.cwd } : {}),
    });
  } catch (error) {
    if (draft.operationId) throw error;
    log.fail('auto', error, { event: 'replace', oldId: draft.targetId });
    const status = `没有替换 #${draft.targetId}：新任务未创建`;
    return { ok: false, status, toast: status };
  }
  if (!created) {
    if (draft.operationId) await ctx.automations.takeDraft(draft.draftId);
    const status = draftTargetGoneStatus(draft.targetId);
    return { ok: false, status, toast: status };
  }
  log.info('auto', 'replaced', { oldId: draft.targetId, newId: created.id });
  scheduleAutomationConfirmed(ctx.onAutomationConfirmed, created);
  const status = draftReplacedStatus(draft.targetId, created.id);
  return { ok: true, status, toast: status };
}

function confirmInvalid(): AutomationConfirmOutcome {
  return { ok: false, status: DRAFT_SETTLED_CANCELLED, toast: AUTO_INVALID_HINT };
}

function scheduleAutomationConfirmed(
  onConfirmed: ((item: AutomationItem) => void | Promise<void>) | undefined,
  item: AutomationItem,
): void {
  if (!onConfirmed) return;
  void (async () => {
    try {
      await onConfirmed(item);
    } catch (error) {
      log.fail('auto', error, { event: 'confirmed-follow-up', id: item.id });
    }
  })();
}

function findSameNameCreateConflict(
  store: AutomationsStore,
  draft: Exclude<AutomationDraft, DeleteAutomationDraft | ReplaceAutomationDraft>,
): AutomationItem | undefined {
  const name = draft.name.trim();
  return store.list().find(item => item.chatId === draft.chatId && item.createdBy === draft.createdBy
    && item.name.trim() === name && (store.appliedOperationAppliedAt(item.id) ?? 0) >= draft.createdAt);
}

function replaceConfirmBlock(draft: ReplaceAutomationDraft, now: number): AutomationScheduleVerdict {
  if (draft.taskType === 'agent' && !(draft.cwd && draft.cwd.trim())) {
    return { outcome: 'refuse', message: AUTO_AGENT_NEEDS_CWD };
  }
  if (draft.scheduleText) {
    const textVerdict = assessAutomationSchedule({
      taskType: draft.taskType,
      scheduleText: draft.scheduleText,
      now,
      timezone: draft.timezone,
      hasCwd: true,
    });
    if (textVerdict.outcome === 'reject' && textVerdict.reason === 'past-time') return textVerdict;
    if (textVerdict.outcome === 'refuse') return textVerdict;
  }
  const stored = readSchedule(draft.schedule);
  if (!stored) return { outcome: 'reject', reason: 'invalid-schedule' };
  if (stored.kind === 'one-shot' && stored.fireAt <= now) {
    const parts = zonedParts(draft.timezone, stored.fireAt);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return { outcome: 'reject', reason: 'past-time', clock: `${pad(parts.hour)}:${pad(parts.minute)}` };
  }
  const parsed = parseSchedule(stored, { taskType: draft.taskType, now });
  if (!parsed.ok) {
    if (parsed.reason === 'lead-too-soon' && hasRemainingFire(stored, now)) {
      return { outcome: 'confirm', schedule: stored };
    }
    return { outcome: 'reject', reason: parsed.reason };
  }
  if (!hasRemainingFire(parsed.schedule, now)) {
    return { outcome: 'reject', reason: 'no-remaining-fires' };
  }
  return { outcome: 'confirm', schedule: parsed.schedule };
}

async function listAutos(ctx: CommandContext): Promise<void> {
  if (!ctx.automations) {
    await replyAuto(ctx, AUTO_LIST_EMPTY);
    return;
  }
  const items = ctx.automations.list().filter((item) => item.chatId === ctx.msg.chatId);
  if (items.length === 0) {
    await replyAuto(ctx, AUTO_LIST_EMPTY);
    return;
  }
  await replyAuto(ctx, items.map(formatAutomationListLine).join('\n'));
}

async function mutateAuto(
  ctx: CommandContext,
  op: 'pause' | 'resume' | 'delete',
  id: number,
): Promise<void> {
  if (!ctx.automations || !ctx.automationsScheduler) {
    await replyAuto(ctx, AUTO_UNKNOWN_ID);
    return;
  }
  const result = await mutateAutomationTask({ store: ctx.automations, scheduler: ctx.automationsScheduler, chatId: ctx.msg.chatId, now: ctx.now }, op, id);
  if (result.ok) log.info('auto', { pause: 'paused', resume: 'resumed', delete: 'deleted' }[op], { id });
  await replyAuto(ctx, result.ok ? `已${taskMutationLabels[op]} #${id} ${result.item.name}` : AUTO_UNKNOWN_ID);
}

async function postEndCard(
  ctx: {
    channel: CommandContext['channel'];
    automations?: AutomationsStore;
    autoAuth?: AutoActionAuth;
    automationsScheduler?: CommandContext['automationsScheduler'];
    chatMode: CommandContext['chatMode'];
    msg: { chatId: string; messageId?: string; threadId?: string };
  },
  draft: Exclude<AutomationDraft, DeleteAutomationDraft>,
): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth) return;
  const tokens = signEndTokens(ctx.autoAuth, draft);
  const card = automationEndCard(tokens);
  let sent: Awaited<ReturnType<typeof sendManagedCard>>;
  try {
    sent = await sendAutomationDraftCard(ctx.channel, ctx.automations, draft, card, {
      replyTo: ctx.msg.messageId,
      ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true, threadId: ctx.msg.threadId } : {}),
    });
  } catch (error) {
    if (draft.operationId) {
      await abandonIfNotInChat(error, draft.chatId, chatId => ctx.automationsScheduler?.removeFromChat(chatId));
      throw error;
    }
    await settleDraftCardFailure(ctx, draft, error, ctx.msg.messageId ?? '');
    return;
  }
  await ctx.automations.bindDraftCard(
    draft.draftId,
    sent.messageId,
    sent.cardId,
    draftCardBodyFromCard(card),
  );
}

async function postConfirmCard(
  ctx: {
    channel: CommandContext['channel'];
    automations?: AutomationsStore;
    autoAuth?: AutoActionAuth;
    automationsScheduler?: CommandContext['automationsScheduler'];
    chatMode: CommandContext['chatMode'];
    msg: { chatId: string; threadId?: string };
  },
  draft: Exclude<AutomationDraft, DeleteAutomationDraft>,
  schedule: Schedule,
  now: number,
  replyTo: string,
): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth) return;
  if (!hasRemainingFire(schedule, now)) {
    try {
      await ctx.channel.send(
        ctx.msg.chatId,
        { markdown: AUTO_NO_REMAINING_FIRES },
        {
          ...(replyTo ? { replyTo } : {}),
          ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true } : {}),
        },
      );
    } catch (error) {
      if (await abandonIfNotInChat(error, ctx.msg.chatId, (chatId) => ctx.automationsScheduler?.removeFromChat(chatId))) {
        return;
      }
      if (classify(error) === 'link') return;
      log.warn('auto', 'reply-failed', { err: error instanceof Error ? error.message : String(error) });
    }
    await ctx.automations.takeDraft(draft.draftId);
    noteAutomationRejected('no-remaining-fires', 'command');
    return;
  }
  const confirmToken = ctx.autoAuth.sign({
    draftId: draft.draftId,
    chatId: draft.chatId,
    action: 'auto.confirm',
    ttlMs: AUTO_CARD_TTL_MS,
  });
  const rejectToken = ctx.autoAuth.sign({
    draftId: draft.draftId,
    chatId: draft.chatId,
    action: 'auto.reject',
    ttlMs: AUTO_CARD_TTL_MS,
  });
  const body = {
    taskType: draft.taskType,
    name: draft.name,
    taskText: draft.taskText,
    timezone: draft.timezone,
    schedule,
    now,
    confirmToken,
    rejectToken,
    ...(draft.cwd ? { cwd: draft.cwd } : {}),
  };
  const card = draft.op === 'replace'
    ? automationReplaceCard({ ...body, target: draft.target })
    : automationConfirmCard(body);
  let sent: Awaited<ReturnType<typeof sendManagedCard>>;
  try {
    sent = await sendAutomationDraftCard(ctx.channel, ctx.automations, draft, card, {
      replyTo,
      ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true, threadId: ctx.msg.threadId } : {}),
    });
  } catch (error) {
    if (draft.operationId) {
      await abandonIfNotInChat(error, draft.chatId, chatId => ctx.automationsScheduler?.removeFromChat(chatId));
      throw error;
    }
    await settleDraftCardFailure(ctx, draft, error, replyTo);
    return;
  }
  await ctx.automations.bindDraftCard(
    draft.draftId,
    sent.messageId,
    sent.cardId,
    draftCardBodyFromCard(card),
  );
}

async function postDeleteCard(
  ctx: {
    channel: CommandContext['channel'];
    automations?: AutomationsStore;
    autoAuth?: AutoActionAuth;
    automationsScheduler?: CommandContext['automationsScheduler'];
    chatMode: CommandContext['chatMode'];
    msg: { chatId: string; messageId?: string; threadId?: string };
  },
  draft: DeleteAutomationDraft,
): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth) return;
  const confirmToken = ctx.autoAuth.sign({
    draftId: draft.draftId,
    chatId: draft.chatId,
    action: 'auto.confirm',
    ttlMs: AUTO_CARD_TTL_MS,
  });
  const rejectToken = ctx.autoAuth.sign({
    draftId: draft.draftId,
    chatId: draft.chatId,
    action: 'auto.reject',
    ttlMs: AUTO_CARD_TTL_MS,
  });
  const card = automationDeleteCard({
    target: draft.target,
    confirmToken,
    rejectToken,
  });
  let sent: Awaited<ReturnType<typeof sendManagedCard>>;
  try {
    sent = await sendAutomationDraftCard(ctx.channel, ctx.automations, draft, card, {
      ...(ctx.msg.messageId ? { replyTo: ctx.msg.messageId } : {}),
      ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true, threadId: ctx.msg.threadId } : {}),
    });
  } catch (error) {
    if (draft.operationId) {
      await abandonIfNotInChat(error, draft.chatId, chatId => ctx.automationsScheduler?.removeFromChat(chatId));
      throw error;
    }
    await settleDraftCardFailure(ctx, draft, error, ctx.msg.messageId ?? '');
    return;
  }
  await ctx.automations.bindDraftCard(
    draft.draftId,
    sent.messageId,
    sent.cardId,
    draftCardBodyFromCard(card),
  );
}

async function settleDraftCardFailure(
  ctx: {
    channel: CommandContext['channel'];
    automations?: AutomationsStore;
    automationsScheduler?: CommandContext['automationsScheduler'];
    chatMode: CommandContext['chatMode'];
    msg: { chatId: string; messageId?: string; threadId?: string };
  },
  draft: AutomationDraft,
  error: unknown,
  replyTo: string,
): Promise<void> {
  if (await abandonIfNotInChat(error, draft.chatId, (chatId) => ctx.automationsScheduler?.removeFromChat(chatId))) {
    return;
  }
  if (isNotInChat(error)) throw error;
  if (ctx.automations?.getDraft(draft.draftId)?.delivery?.state === 'sending') return;
  const kind = classify(error);
  const { code } = readCardApiError(error);
  switch (kind) {
    case 'link':
      log.info('auto', 'draft.card-deferred', {
        draftId: draft.draftId,
        ...(code !== undefined ? { code } : {}),
      });
      return;
    case 'rejected':
    case 'local': {
      const notice = await replyDraftCardFailed(ctx, replyTo, code);
      if (notice === 'deferred') {
        log.info('auto', 'draft.card-deferred', {
          draftId: draft.draftId,
          ...(code !== undefined ? { code } : {}),
        });
        return;
      }
      await ctx.automations?.takeDraft(draft.draftId);
      log.warn('auto', 'draft.card-failed', {
        draftId: draft.draftId,
        ...(code !== undefined ? { code } : {}),
      });
      return;
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

async function replyDraftCardFailed(
  ctx: {
    channel: CommandContext['channel'];
    automationsScheduler?: CommandContext['automationsScheduler'];
    chatMode: CommandContext['chatMode'];
    msg: { chatId: string; threadId?: string };
  },
  replyTo: string,
  code: number | undefined,
): Promise<'sent' | 'deferred' | 'dropped'> {
  const shown = code === undefined ? 'unknown' : String(code);
  const markdown = `确认卡片发送失败（飞书错误 ${shown}），未创建任务。请稍后重试。`;
  try {
    await ctx.channel.send(
      ctx.msg.chatId,
      { markdown },
      {
        ...(replyTo ? { replyTo } : {}),
        ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true } : {}),
      },
    );
    return 'sent';
  } catch (err) {
    if (await abandonIfNotInChat(err, ctx.msg.chatId, (chatId) => ctx.automationsScheduler?.removeFromChat(chatId))) {
      return 'dropped';
    }
    if (isNotInChat(err)) throw err;
    if (classify(err) === 'link') return 'deferred';
    log.warn('auto', 'reply-failed', { err: err instanceof Error ? err.message : String(err) });
    return 'dropped';
  }
}

function signEndTokens(auth: AutoActionAuth, draft: AutomationDraft): EndCardTokens {
  const sign = (action: AutoCardAction): string => auth.sign({
    draftId: draft.draftId,
    chatId: draft.chatId,
    action,
    ttlMs: AUTO_CARD_TTL_MS,
  });
  return {
    'auto.end.1w': sign('auto.end.1w'),
    'auto.end.2w': sign('auto.end.2w'),
    'auto.end.1m': sign('auto.end.1m'),
    'auto.end.3m': sign('auto.end.3m'),
    'auto.end.eoy': sign('auto.end.eoy'),
    'auto.end.1y': sign('auto.end.1y'),
    'auto.end.custom': sign('auto.end.custom'),
    'auto.reject': sign('auto.reject'),
  };
}

function scheduleStartAt(schedule: Schedule, now: number): number {
  switch (schedule.kind) {
    case 'one-shot':
      return now;
    case 'daily':
    case 'weekday':
    case 'weekly':
    case 'interval':
      return schedule.startAt;
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}

function scheduleEndAt(schedule: Schedule): number | undefined {
  switch (schedule.kind) {
    case 'one-shot':
      return undefined;
    case 'daily':
    case 'weekday':
    case 'weekly':
    case 'interval':
      return schedule.endAt;
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}

function isIgnoredAutoSender(ctx: Pick<CommandContext, 'msg' | 'channel'>): boolean {
  const senderType = senderTypeFromMessage(ctx.msg);
  if (senderType === 'app' || senderType === 'bot') return true;
  const botOpenId = ctx.channel.botIdentity?.openId;
  return Boolean(botOpenId) && ctx.msg.senderId === botOpenId;
}

async function replyAuto(ctx: AutomationCommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(
      ctx.msg.chatId,
      { markdown },
      {
        replyTo: ctx.msg.messageId,
        ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
      },
    );
  } catch (err) {
    if (await abandonIfNotInChat(err, ctx.msg.chatId, (chatId) => ctx.automationsScheduler?.removeFromChat(chatId))) {
      return;
    }
    log.warn('auto', 'reply-failed', { err: err instanceof Error ? err.message : String(err) });
  }
}
