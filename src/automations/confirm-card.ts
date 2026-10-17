import { monthlyFireCount, nextFires, type Schedule } from './schedule';
import { zonedParts } from './zoned-time';
import type { AutomationTaskType } from './store';

interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

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

export function describeIdentity(taskType: AutomationTaskType, cwd?: string): string {
  if (taskType === 'reminder') return '本 bot 发送提醒（不跑 agent）';
  const cwdNote = cwd ? '；已快照工作目录' : '';
  return `本 profile 的 agent${cwdNote}；默认自动批准工具；agent 有完整 shell`;
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
  const fires = nextFires(input.schedule, input.now, 3);
  const monthly = monthlyFireCount(input.schedule, input.now);
  const fireLines = fires.length === 0
    ? '- （无后续触发）'
    : fires.map((fireAt) => `- ${formatZonedDateTime(input.timezone, fireAt)}`).join('\n');
  const weekdayNote = input.schedule.kind === 'weekday' ? '\n工作日不计调休' : '';
  const typeLabel = input.taskType === 'reminder' ? '提醒' : 'agent 任务';
  const body = [
    `**任务类型：** ${typeLabel}`,
    `**名称：** ${escapeMd(input.name)}`,
    `**时间表：** ${escapeMd(describeSchedule(input.schedule, input.timezone))}${weekdayNote}`,
    `**时区：** ${escapeMd(input.timezone)}`,
    `**接下来 3 次：**\n${fireLines}`,
    `**结束：** ${escapeMd(describeEnd(input.schedule, input.timezone))}`,
    `**任务：** ${escapeMd(input.taskText)}`,
    `**执行身份：** ${escapeMd(describeIdentity(input.taskType, input.cwd))}`,
    `约每月 ${monthly} 次`,
  ].join('\n\n');

  return shell('确认自动化', [
    divMd(body),
    HR,
    actions([
      {
        text: '是',
        value: { cmd: 'auto.confirm', auto_token: input.confirmToken },
        style: 'primary',
      },
      {
        text: '否',
        value: { cmd: 'auto.reject', auto_token: input.rejectToken },
      },
    ]),
  ]);
}
