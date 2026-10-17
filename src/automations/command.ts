import type { NormalizedMessage } from '@larksuite/channel';
import { sendManagedCard } from '../card/managed';
import { log } from '../core/logger';
import { senderTypeFromRaw } from '../bot/self-message';
import type { CommandContext } from '../commands';
import { AUTO_CARD_TTL_MS, type AutoActionAuth, type AutoCardAction } from './action-auth';
import { automationConfirmCard } from './confirm-card';
import { automationEndCard, type EndCardTokens } from './end-card';
import {
  ONE_YEAR_MS,
  nextFireAfter,
  parseSchedule,
  type LocalTime,
  type ParseScheduleResult,
  type PendingRecurring,
  type Schedule,
  type ScheduleRejectReason,
  type TaskType,
} from './schedule';
import { addLocalDays, zonedLocalToUtc, zonedParts } from './zoned-time';
import { formatAutomationListLine } from './board-card';
import type { AutomationDraft, AutomationItem, AutomationTaskType, AutomationsStore } from './store';

export const AUTO_NEW_USAGE = '用法：`/auto new <时间表> | <名称> | <任务>`';
export const AUTO_P2P_HINT = '仅支持群';
export const AUTO_INVALID_HINT = '此确认已失效。';
export const AUTO_LEAD_TOO_SOON = '最早 10 分钟后。';
export const AUTO_ONE_SHOT_TOO_FAR = '一次性任务不能超过 1 年。';
export const AUTO_AGENT_DISABLED = 'agent 任务未开启。';
export const AUTO_AGENT_NEEDS_CWD = '请先用 `/cd` 设置工作目录。';
export const AUTO_MISSING_END = '周期任务必须指定结束时间。';
export const AUTO_INTERVAL_TOO_SMALL = '间隔过短。';
export const AUTO_INVALID_SCHEDULE = '无法解析时间表。';
export const AUTO_UNKNOWN_ID = '没有这个编号。';
export const AUTO_LIST_EMPTY = '暂无';
export const AUTO_INVALID_END = '无法解析结束时间。';

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

export type ParseScheduleTextResult =
  | { ok: true; schedule: Schedule }
  | { ok: false; reason: ScheduleRejectReason; pending?: PendingRecurring };

export function parseScheduleText(
  text: string,
  options: { taskType: TaskType; now: number; timezone: string },
): ParseScheduleTextResult {
  const relative = parseRelative(text, options.now);
  if (relative !== undefined) {
    return parseSchedule({ kind: 'one-shot', fireAt: relative }, options);
  }
  const absolute = parseAbsolute(text, options.timezone);
  if (absolute !== undefined) {
    return parseSchedule({ kind: 'one-shot', fireAt: absolute }, options);
  }
  return parseRecurringText(text, options);
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
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
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
  action: Extract<AutoCardAction, 'auto.end.1m' | 'auto.end.3m' | 'auto.end.eoy' | 'auto.end.1y'>,
  timezone: string,
  now: number,
  startAt = now,
): number {
  const parts = zonedParts(timezone, now);
  switch (action) {
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
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  return zonedLocalToUtc(timezone, year, month, day, hour, minute);
}

function parseRecurringText(
  text: string,
  options: { taskType: TaskType; now: number; timezone: string },
): ParseScheduleTextResult {
  const { body, endText } = splitEndSuffix(text);
  const pending = parsePendingRecurring(body, options.timezone);
  if (!pending) return { ok: false, reason: 'invalid-schedule' };

  const probe = completePendingSchedule(pending, options.now + 30 * 24 * 60 * 60_000, {
    taskType: options.taskType,
    now: options.now,
    startAt: options.now,
  });
  if (!probe.ok && probe.reason !== 'missing-end-at' && probe.reason !== 'recurring-too-long') {
    return { ok: false, reason: probe.reason };
  }

  if (endText === undefined) {
    return { ok: false, reason: 'missing-end-at', pending };
  }
  const endAt = parseEndAtText(endText, options.timezone);
  if (endAt === undefined) return { ok: false, reason: 'invalid-schedule' };
  return completePendingSchedule(pending, endAt, {
    taskType: options.taskType,
    now: options.now,
    startAt: options.now,
  });
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

function addLocalMonths(
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

export function rejectMessage(reason: ScheduleRejectReason): string {
  switch (reason) {
    case 'lead-too-soon':
      return AUTO_LEAD_TOO_SOON;
    case 'one-shot-too-far':
      return AUTO_ONE_SHOT_TOO_FAR;
    case 'missing-end-at':
      return AUTO_MISSING_END;
    case 'interval-too-small':
      return AUTO_INTERVAL_TOO_SMALL;
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

export type AutomationProposalContext = Pick<
  CommandContext,
  | 'channel'
  | 'msg'
  | 'scope'
  | 'chatMode'
  | 'workspaces'
  | 'automations'
  | 'autoAuth'
  | 'now'
  | 'controls'
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
      await submitAutomationProposal(ctx, parsed);
      return;
    default: {
      const _exhaustive: never = parsed;
      return _exhaustive;
    }
  }
}

export async function submitAutomationProposal(
  ctx: AutomationProposalContext,
  parsed: ParsedAutoNew,
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
  const parsedSchedule = parseScheduleText(parsed.scheduleText, {
    taskType: parsed.taskType,
    now,
    timezone,
  });
  if (!parsedSchedule.ok && !(parsedSchedule.reason === 'missing-end-at' && parsedSchedule.pending)) {
    await replyAuto(ctx, rejectMessage(parsedSchedule.reason));
    return;
  }

  const cwd = parsed.taskType === 'agent'
    ? ctx.workspaces.cwdFor(ctx.scope) ?? ctx.controls.profileConfig.workspaces.default
    : undefined;
  if (parsed.taskType === 'agent' && !(typeof cwd === 'string' && cwd.trim())) {
    await replyAuto(ctx, AUTO_AGENT_NEEDS_CWD);
    return;
  }

  if (!parsedSchedule.ok) {
    const draft = await ctx.automations.saveDraft({
      taskType: parsed.taskType,
      schedule: parsedSchedule.pending,
      timezone,
      startAt: now,
      nextFireAt: 0,
      chatId: ctx.msg.chatId,
      createdBy: ctx.msg.senderId,
      name: parsed.name,
      taskText: parsed.taskText,
      pendingRecurring: parsedSchedule.pending,
      ...(cwd ? { cwd } : {}),
    });
    await postEndCard(ctx, draft);
    log.info('auto', 'draft', {
      draftId: draft.draftId,
      taskType: parsed.taskType,
      chatId: ctx.msg.chatId,
      waiting: 'end',
    });
    return;
  }

  const nextFireAt = nextFireAfter(parsedSchedule.schedule, now);
  const startAt = scheduleStartAt(parsedSchedule.schedule, now);
  const endAt = scheduleEndAt(parsedSchedule.schedule);
  const draft = await ctx.automations.saveDraft({
    taskType: parsed.taskType,
    schedule: parsedSchedule.schedule,
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
  await postConfirmCard(ctx, draft, parsedSchedule.schedule, now, ctx.msg.messageId);
  log.info('auto', 'draft', {
    draftId: draft.draftId,
    taskType: parsed.taskType,
    chatId: ctx.msg.chatId,
  });
}

export async function completeDraftEnd(
  ctx: {
    automations: AutomationsStore;
    autoAuth: AutoActionAuth;
    channel: CommandContext['channel'];
    now?: () => number;
    chatMode?: CommandContext['chatMode'];
  },
  draft: AutomationDraft,
  endAt: number,
  replyTo: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const pending = draft.pendingRecurring;
  if (!pending) return { ok: false, message: AUTO_INVALID_HINT };
  const now = (ctx.now ?? Date.now)();
  const parsed = completePendingSchedule(pending, endAt, {
    taskType: draft.taskType,
    now,
    startAt: draft.startAt,
  });
  if (!parsed.ok) return { ok: false, message: rejectMessage(parsed.reason) };
  const nextFireAt = nextFireAfter(parsed.schedule, now);
  const updated = await ctx.automations.updateDraft(draft.draftId, {
    schedule: parsed.schedule,
    endAt,
    nextFireAt,
    pendingRecurring: null,
  });
  if (!updated) return { ok: false, message: AUTO_INVALID_HINT };
  await postConfirmCard({
    channel: ctx.channel,
    automations: ctx.automations,
    autoAuth: ctx.autoAuth,
    chatMode: ctx.chatMode ?? 'group',
    msg: { chatId: draft.chatId, threadId: undefined },
  }, updated, parsed.schedule, now, replyTo);
  return { ok: true };
}

export function resolveEndAt(
  action: AutoCardAction,
  input: { timezone: string; now: number; startAt?: number; customText?: string },
): number | undefined {
  switch (action) {
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

export async function confirmAutomationDraft(
  ctx: Pick<CommandContext, 'automations' | 'onAutomationConfirmed'>,
  draft: AutomationDraft,
): Promise<AutomationItem | undefined> {
  if (!ctx.automations || draft.pendingRecurring) return undefined;
  const item = await ctx.automations.create({
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
  await ctx.onAutomationConfirmed?.(item);
  log.info('auto', 'confirmed', { id: item.id, taskType: item.taskType, chatId: item.chatId });
  return item;
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
  const item = ctx.automations.get(id);
  if (!item || item.chatId !== ctx.msg.chatId) {
    await replyAuto(ctx, AUTO_UNKNOWN_ID);
    return;
  }
  let ok = false;
  switch (op) {
    case 'pause':
      ok = await ctx.automationsScheduler.pause(id);
      if (ok) log.info('auto', 'paused', { id });
      await replyAuto(ctx, ok ? `已暂停 #${id} ${item.name}` : AUTO_UNKNOWN_ID);
      return;
    case 'resume':
      ok = await ctx.automationsScheduler.resume(id);
      if (ok) log.info('auto', 'resumed', { id });
      await replyAuto(ctx, ok ? `已恢复 #${id} ${item.name}` : AUTO_UNKNOWN_ID);
      return;
    case 'delete':
      ok = await ctx.automationsScheduler.delete(id);
      if (ok) log.info('auto', 'deleted', { id });
      await replyAuto(ctx, ok ? `已删除 #${id} ${item.name}` : AUTO_UNKNOWN_ID);
      return;
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

async function postEndCard(
  ctx: Pick<CommandContext, 'channel' | 'automations' | 'autoAuth' | 'msg' | 'chatMode'>,
  draft: AutomationDraft,
): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth) return;
  const tokens = signEndTokens(ctx.autoAuth, draft);
  const sent = await sendManagedCard(ctx.channel, ctx.msg.chatId, automationEndCard(tokens), {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true } : {}),
  });
  await ctx.automations.bindDraftCard(draft.draftId, sent.messageId);
}

async function postConfirmCard(
  ctx: {
    channel: CommandContext['channel'];
    automations?: AutomationsStore;
    autoAuth?: AutoActionAuth;
    chatMode: CommandContext['chatMode'];
    msg: { chatId: string; threadId?: string };
  },
  draft: AutomationDraft,
  schedule: Schedule,
  now: number,
  replyTo: string,
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
  const card = automationConfirmCard({
    taskType: draft.taskType,
    name: draft.name,
    taskText: draft.taskText,
    timezone: draft.timezone,
    schedule,
    now,
    confirmToken,
    rejectToken,
    ...(draft.cwd ? { cwd: draft.cwd } : {}),
  });
  const sent = await sendManagedCard(ctx.channel, ctx.msg.chatId, card, {
    replyTo,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true } : {}),
  });
  await ctx.automations.bindDraftCard(draft.draftId, sent.messageId);
}

function signEndTokens(auth: AutoActionAuth, draft: AutomationDraft): EndCardTokens {
  const sign = (action: AutoCardAction): string => auth.sign({
    draftId: draft.draftId,
    chatId: draft.chatId,
    action,
    ttlMs: AUTO_CARD_TTL_MS,
  });
  return {
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
  const senderType = senderTypeFromRaw((ctx.msg as NormalizedMessage & { raw?: unknown }).raw);
  if (senderType === 'app' || senderType === 'bot') return true;
  const botOpenId = ctx.channel.botIdentity?.openId;
  return Boolean(botOpenId) && ctx.msg.senderId === botOpenId;
}

async function replyAuto(ctx: AutomationProposalContext, markdown: string): Promise<void> {
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
    log.warn('auto', 'reply-failed', { err: err instanceof Error ? err.message : String(err) });
  }
}
