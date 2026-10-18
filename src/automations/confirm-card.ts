import { buttonRow, callbackButton, card2, hr, md } from '../card/v2';
import { monthlyFireCount, nextFires, type Schedule } from './schedule';
import { zonedParts } from './zoned-time';
import type { AutomationTaskType } from './store';

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

const SHORT_HORIZON_MS = 30 * 24 * 60 * 60_000;
/** Above a month of the 10-minute floor, so a horizon under 30 days is not truncated. */
const SHORT_HORIZON_FIRE_CAP = 30 * 24 * 6 + 1;

function frequencyLine(schedule: Schedule, now: number): string | undefined {
  switch (schedule.kind) {
    case 'one-shot':
      return undefined;
    case 'daily':
    case 'weekday':
    case 'weekly':
    case 'interval':
      if (schedule.endAt - now < SHORT_HORIZON_MS) {
        return `共 ${nextFires(schedule, now, SHORT_HORIZON_FIRE_CAP).length} 次`;
      }
      return `约每月 ${monthlyFireCount(schedule, now)} 次`;
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
  return `本 profile 的 agent，仅 bot 身份${cwdNote}；默认自动批准工具；agent 有完整 shell，这是纵深防御不是安全边界`;
}

export function automationConfirmCard(input: {
  taskType: AutomationTaskType;
  name: string;
  taskText: string;
  timezone: string;
  schedule: Schedule;
  now: number;
  confirmToken: string;
  rejectToken: string;
  cwd?: string;
}): object {
  const frequency = frequencyLine(input.schedule, input.now);
  const weekdayNote = input.schedule.kind === 'weekday' ? '\n工作日不计调休' : '';
  const typeLabel = input.taskType === 'reminder' ? '提醒' : 'agent 任务';
  const startLine = describeStart(input.schedule, input.timezone, input.now);
  const scheduleBlock = [
    `**时间表：** ${escapeMd(describeSchedule(input.schedule, input.timezone))}${weekdayNote}`,
    ...(startLine ? [escapeMd(startLine)] : []),
  ].join('\n');
  const body = [
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

  return card2({
    title: '确认自动化',
    summary: '确认自动化',
    elements: [
      md(body),
      hr,
      buttonRow([
        callbackButton({
          text: '是',
          value: { cmd: 'auto.confirm', auto_token: input.confirmToken },
          style: 'primary',
        }),
        callbackButton({
          text: '否',
          value: { cmd: 'auto.reject', auto_token: input.rejectToken },
        }),
      ]),
    ],
  });
}
