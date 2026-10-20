import { buttonRow, callbackButton, card2, hr, md } from '../card/v2';
import {
  EXACT_FIRE_COUNT_CAP,
  monthlyFireCount,
  nextFires,
  readSchedule,
  scheduleOccurrenceCount,
  type Schedule,
} from './schedule';
import { zonedParts } from './zoned-time';
import { automationTargetRevision } from './store';
import type { AutomationItem, AutomationTargetSnapshot, AutomationTaskType } from './store';

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

export function formatZonedDateTime(timeZone: string, utcMs: number): string {
  const parts = zonedParts(timeZone, utcMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

function formatLocalTime(time: { hour: number; minute: number }): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(time.hour)}:${pad(time.minute)}`;
}

const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

function weekdayLabel(day: number): string {
  return WEEKDAY_LABELS[day] ?? `周${day}`;
}

export function describeSchedule(schedule: Schedule, timezone: string): string {
  switch (schedule.kind) {
    case 'one-shot':
      return `一次性 ${formatZonedDateTime(timezone, schedule.fireAt)}`;
    case 'daily':
      return `每天 ${schedule.times.map(formatLocalTime).join('、')}`;
    case 'weekday':
      return `每个工作日 ${schedule.times.map(formatLocalTime).join('、')}`;
    case 'weekly':
      return `每周${schedule.weekdays.map(weekdayLabel).join('、')} ${schedule.times.map(formatLocalTime).join('、')}`;
    case 'interval': {
      const everyMin = schedule.everyMs / 60_000;
      const every = everyMin % 60 === 0 ? `每 ${everyMin / 60} 小时` : `每 ${everyMin} 分钟`;
      if (!schedule.window) return every;
      return `${every} ${formatLocalTime(schedule.window.from)}–${formatLocalTime(schedule.window.to)}`;
    }
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}

export function describeEnd(schedule: Schedule, timezone: string): string {
  switch (schedule.kind) {
    case 'one-shot':
      return '一次性';
    case 'daily':
    case 'weekday':
    case 'weekly':
    case 'interval':
      return formatZonedDateTime(timezone, schedule.endAt);
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}

function describeStart(schedule: Schedule, timezone: string, now: number): string | undefined {
  switch (schedule.kind) {
    case 'one-shot':
      return undefined;
    case 'daily':
    case 'weekday':
    case 'weekly':
    case 'interval':
      return schedule.startAt > now
        ? `从 ${formatZonedDateTime(timezone, schedule.startAt)} 开始`
        : undefined;
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}

function frequencyLine(schedule: Schedule, now: number): string | undefined {
  switch (schedule.kind) {
    case 'one-shot':
      return undefined;
    case 'daily':
    case 'weekday':
    case 'weekly':
    case 'interval': {
      const counted = scheduleOccurrenceCount(schedule, now);
      if (counted.capped) {
        return `超过 ${EXACT_FIRE_COUNT_CAP} 次 · 约每月 ${monthlyFireCount(schedule, now)} 次`;
      }
      return `共 ${counted.count} 次`;
    }
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}

function upcomingSection(schedule: Schedule, timezone: string, now: number): string {
  switch (schedule.kind) {
    case 'one-shot':
      return `触发时间：${formatZonedDateTime(timezone, schedule.fireAt)}（共 1 次）`;
    case 'daily':
    case 'weekday':
    case 'weekly':
    case 'interval': {
      const fires = nextFires(schedule, now, 3);
      const lines = fires.map((fireAt) => `- ${formatZonedDateTime(timezone, fireAt)}`).join('\n');
      return `**接下来 ${fires.length} 次：**\n${lines}`;
    }
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}

export function describeIdentity(taskType: AutomationTaskType, cwd?: string): string {
  if (taskType === 'reminder') return '本 bot 发送提醒（不跑 agent）';
  const cwdNote = cwd ? '；已快照工作目录' : '';
  return `本 profile 的 agent，沿用 profile 已授权的 bot/user 身份${cwdNote}；默认自动批准工具；agent 有完整 shell，这是纵深防御不是安全边界`;
}

export interface AutomationConfirmBodyInput {
  taskType: AutomationTaskType;
  name: string;
  taskText: string;
  timezone: string;
  schedule: Schedule;
  now: number;
  cwd?: string;
}

export function automationConfirmBody(input: AutomationConfirmBodyInput): string {
  const frequency = frequencyLine(input.schedule, input.now);
  const weekdayNote = input.schedule.kind === 'weekday' ? '\n工作日不计调休' : '';
  const typeLabel = input.taskType === 'reminder' ? '提醒' : 'agent 任务';
  const startLine = describeStart(input.schedule, input.timezone, input.now);
  const scheduleBlock = [
    `**时间表：** ${escapeMd(describeSchedule(input.schedule, input.timezone))}${weekdayNote}`,
    ...(startLine ? [escapeMd(startLine)] : []),
  ].join('\n');
  return [
    `**任务类型：** ${typeLabel}`,
    `**名称：** ${escapeMd(input.name)}`,
    scheduleBlock,
    `**时区：** ${escapeMd(input.timezone)}`,
    upcomingSection(input.schedule, input.timezone, input.now),
    `**结束：** ${escapeMd(describeEnd(input.schedule, input.timezone))}`,
    `**任务：** ${escapeMd(input.taskText)}`,
    `**执行身份：** ${escapeMd(describeIdentity(input.taskType, input.cwd))}`,
    ...(frequency ? [frequency] : []),
  ].join('\n\n');
}

function confirmButtons(confirmToken: string, rejectToken: string): object {
  return buttonRow([
    callbackButton({
      text: '是',
      value: { cmd: 'auto.confirm', auto_token: confirmToken },
      style: 'primary',
    }),
    callbackButton({
      text: '否',
      value: { cmd: 'auto.reject', auto_token: rejectToken },
    }),
  ]);
}

export function automationConfirmCard(input: AutomationConfirmBodyInput & {
  confirmToken: string;
  rejectToken: string;
}): object {
  return card2({
    title: '确认自动化',
    summary: '确认自动化',
    elements: [
      md(automationConfirmBody(input)),
      hr,
      confirmButtons(input.confirmToken, input.rejectToken),
    ],
  });
}

export function automationTargetSnapshot(item: AutomationItem): AutomationTargetSnapshot {
  const schedule = readSchedule(item.schedule);
  const scheduleLabel = schedule ? describeSchedule(schedule, item.timezone) : '时间表未知';
  const nextFireLabel = item.nextFireAt > 0
    ? formatZonedDateTime(item.timezone, item.nextFireAt)
    : '无';
  const endLabel = schedule
    ? describeEnd(schedule, item.timezone)
    : (item.endAt > 0 ? formatZonedDateTime(item.timezone, item.endAt) : '无');
  return {
    revision: automationTargetRevision(item),
    id: item.id,
    name: item.name,
    taskType: item.taskType,
    scheduleLabel,
    nextFireLabel,
    endLabel,
  };
}

export function automationDeleteCard(input: {
  target: AutomationTargetSnapshot;
  confirmToken: string;
  rejectToken: string;
}): object {
  const typeLabel = input.target.taskType === 'reminder' ? '提醒' : 'agent 任务';
  const body = [
    `确认删除 #${input.target.id} ${escapeMd(input.target.name)}？`,
    `**类型：** ${typeLabel}`,
    `**时间表：** ${escapeMd(input.target.scheduleLabel)}`,
    `**下次触发：** ${escapeMd(input.target.nextFireLabel)}`,
    `**结束：** ${escapeMd(input.target.endLabel)}`,
  ].join('\n\n');
  return card2({
    title: '确认删除',
    summary: '确认删除',
    elements: [
      md(body),
      hr,
      confirmButtons(input.confirmToken, input.rejectToken),
    ],
  });
}

export function automationReplaceCard(input: AutomationConfirmBodyInput & {
  target: AutomationTargetSnapshot;
  confirmToken: string;
  rejectToken: string;
}): object {
  const replacement = `替换：#${input.target.id} ${escapeMd(input.target.name)} · ${escapeMd(input.target.scheduleLabel)} → 新设置如下`;
  const numberChange = `确认后原 #${input.target.id} 将由新编号取代`;
  const title = `确认替换 #${input.target.id}`;
  return card2({
    title,
    summary: title,
    elements: [
      md(`${replacement}\n\n${numberChange}\n\n${automationConfirmBody(input)}`),
      hr,
      confirmButtons(input.confirmToken, input.rejectToken),
    ],
  });
}
