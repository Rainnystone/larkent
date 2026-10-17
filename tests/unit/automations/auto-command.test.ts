import { describe, expect, it } from 'vitest';
import {
  parseAutoCommand,
  parseAutoNewArgs,
  parseScheduleText,
} from '../../../src/automations/command';
import { isRegisteredSlashCommand } from '../../../src/commands';

const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);

describe('isRegisteredSlashCommand', () => {
  it('registers /auto only when automations are enabled', () => {
    expect(isRegisteredSlashCommand('/auto new in 15m | 交周报 | 提醒交周报')).toBe(false);
    expect(isRegisteredSlashCommand('/auto new in 15m | 交周报 | 提醒交周报', {
      automationsEnabled: true,
    })).toBe(true);
    expect(isRegisteredSlashCommand('/help', { automationsEnabled: false })).toBe(true);
  });
});

describe('parseAutoCommand', () => {
  it('treats empty / list as list and pause|resume|delete <id> as mutations', () => {
    expect(parseAutoCommand('')).toEqual({ op: 'list' });
    expect(parseAutoCommand('list')).toEqual({ op: 'list' });
    expect(parseAutoCommand('pause 1')).toEqual({ op: 'pause', id: 1 });
    expect(parseAutoCommand('resume 2')).toEqual({ op: 'resume', id: 2 });
    expect(parseAutoCommand('delete 3')).toEqual({ op: 'delete', id: 3 });
    expect(parseAutoCommand('pause 0')).toEqual({ op: 'usage' });
    expect(parseAutoCommand('pause x')).toEqual({ op: 'usage' });
  });
});

describe('parseAutoNewArgs', () => {
  it('splits only the first two pipes and defaults to reminder', () => {
    expect(parseAutoNewArgs('new in 15m | 交周报 | 提醒交周报 | extra')).toEqual({
      taskType: 'reminder',
      scheduleText: 'in 15m',
      name: '交周报',
      taskText: '提醒交周报 | extra',
    });
  });

  it('parses /auto new agent as an agent task', () => {
    expect(parseAutoNewArgs('new agent in 1h | 汇总 | 跑 issue')).toEqual({
      taskType: 'agent',
      scheduleText: 'in 1h',
      name: '汇总',
      taskText: '跑 issue',
    });
  });

  it('rejects missing pipes', () => {
    expect(parseAutoNewArgs('new in 15m 交周报')).toEqual({ ok: false, reason: 'usage' });
    expect(parseAutoNewArgs('list')).toEqual({ ok: false, reason: 'usage' });
  });
});

describe('parseScheduleText', () => {
  it('parses relative and absolute one-shots in the profile timezone', () => {
    expect(parseScheduleText('in 15m', { taskType: 'reminder', now: NOW, timezone: 'Asia/Shanghai' })).toEqual({
      ok: true,
      schedule: { kind: 'one-shot', fireAt: NOW + 15 * 60_000 },
    });
    expect(parseScheduleText('at 2026-10-17 11:15', {
      taskType: 'reminder',
      now: NOW,
      timezone: 'Asia/Shanghai',
    })).toEqual({
      ok: true,
      schedule: { kind: 'one-shot', fireAt: NOW + 15 * 60_000 },
    });
  });

  it('rejects lead times under 10 minutes', () => {
    expect(parseScheduleText('in 5m', { taskType: 'reminder', now: NOW, timezone: 'Asia/Shanghai' })).toEqual({
      ok: false,
      reason: 'lead-too-soon',
    });
  });
});
