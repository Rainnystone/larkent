import type { NormalizedMessage } from '@larksuite/channel';
import { sendManagedCard } from '../card/managed';
import { log } from '../core/logger';
import { senderTypeFromRaw } from '../bot/self-message';
import type { CommandContext } from '../commands';
import { AUTO_CARD_TTL_MS } from './action-auth';
import { automationConfirmCard } from './confirm-card';
import {
  nextFireAfter,
  parseSchedule,
  type ParseScheduleResult,
  type Schedule,
  type ScheduleRejectReason,
  type TaskType,
} from './schedule';
import { zonedLocalToUtc } from './zoned-time';
import type { AutomationDraft, AutomationItem, AutomationTaskType } from './store';

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

export function parseScheduleText(
  text: string,
  options: { taskType: TaskType; now: number; timezone: string },
): ParseScheduleResult {
  const relative = parseRelative(text, options.now);
  if (relative !== undefined) {
    return parseSchedule({ kind: 'one-shot', fireAt: relative }, options);
  }
  const absolute = parseAbsolute(text, options.timezone);
  if (absolute !== undefined) {
    return parseSchedule({ kind: 'one-shot', fireAt: absolute }, options);
  }
  return { ok: false, reason: 'invalid-schedule' };
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

export async function handleAutoCommand(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.controls.profileConfig.automations.enabled) return;
  if (isIgnoredAutoSender(ctx)) return;
  if (ctx.scope.startsWith('auto:') || ctx.scope.startsWith('meeting:')) return;
  if (ctx.chatMode === 'p2p' || ctx.msg.chatType === 'p2p') {
    await replyAuto(ctx, AUTO_P2P_HINT);
    return;
  }

  const parsed = parseAutoNewArgs(args);
  if ('ok' in parsed) {
    await replyAuto(ctx, AUTO_NEW_USAGE);
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
  if (!parsedSchedule.ok) {
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

  const confirmToken = ctx.autoAuth.sign({
    draftId: draft.draftId,
    chatId: ctx.msg.chatId,
    action: 'auto.confirm',
    ttlMs: AUTO_CARD_TTL_MS,
  });
  const rejectToken = ctx.autoAuth.sign({
    draftId: draft.draftId,
    chatId: ctx.msg.chatId,
    action: 'auto.reject',
    ttlMs: AUTO_CARD_TTL_MS,
  });
  const card = automationConfirmCard({
    taskType: parsed.taskType,
    name: parsed.name,
    taskText: parsed.taskText,
    timezone,
    schedule: parsedSchedule.schedule,
    now,
    confirmToken,
    rejectToken,
    ...(cwd ? { cwd } : {}),
  });
  const sent = await sendManagedCard(ctx.channel, ctx.msg.chatId, card, {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true } : {}),
  });
  await ctx.automations.bindDraftCard(draft.draftId, sent.messageId);
  log.info('auto', 'draft', {
    draftId: draft.draftId,
    taskType: parsed.taskType,
    chatId: ctx.msg.chatId,
  });
}

export async function confirmAutomationDraft(
  ctx: Pick<CommandContext, 'automations' | 'onAutomationConfirmed'>,
  draft: AutomationDraft,
): Promise<AutomationItem | undefined> {
  if (!ctx.automations) return undefined;
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
  ctx.onAutomationConfirmed?.(item);
  log.info('auto', 'confirmed', { id: item.id, taskType: item.taskType, chatId: item.chatId });
  return item;
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

function isIgnoredAutoSender(ctx: CommandContext): boolean {
  const senderType = senderTypeFromRaw((ctx.msg as NormalizedMessage & { raw?: unknown }).raw);
  if (senderType === 'app' || senderType === 'bot') return true;
  const botOpenId = ctx.channel.botIdentity?.openId;
  return Boolean(botOpenId) && ctx.msg.senderId === botOpenId;
}

async function replyAuto(ctx: CommandContext, markdown: string): Promise<void> {
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
