import { describe, expect, it } from 'vitest';
import {
  automationConfirmCard,
  describeEnd,
  describeIdentity,
  describeSchedule,
} from '../../../src/automations/confirm-card';
import type { Schedule } from '../../../src/automations/schedule';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const END = NOW + 30 * 24 * 60 * 60 * 1000;

describe('confirm card copy', () => {
  it('describes every schedule kind for reuse by later tickets', () => {
    expect(describeSchedule({ kind: 'one-shot', fireAt: NOW + 15 * 60_000 }, TZ))
      .toBe('一次性 2026-10-17 11:15');
    expect(describeSchedule(daily(), TZ)).toBe('每天 09:00、18:00');
    expect(describeSchedule(weekday(), TZ)).toBe('每个工作日 09:30');
    expect(describeSchedule(weekly(), TZ)).toBe('每周周一、周三 10:00');
    expect(describeSchedule(interval(), TZ)).toBe('每 1 小时 09:00–18:00');
    expect(describeSchedule({
      kind: 'interval',
      timezone: TZ,
      everyMs: 60 * 60_000,
      startAt: NOW,
      endAt: END,
    }, TZ)).toBe('每 1 小时');
  });

  it('shows the one-shot fire time without a monthly frequency', () => {
    const soon = NOW + 15 * 60_000;
    const later = NOW + 40 * 24 * 60 * 60_000;
    const soonCard = confirmBody({ kind: 'one-shot', fireAt: soon });
    const laterCard = confirmBody({ kind: 'one-shot', fireAt: later });
    expect(soonCard).not.toContain('约每月');
    expect(laterCard).not.toContain('约每月');
    expect(soonCard).not.toContain('约每月 1 次');
    expect(laterCard).not.toContain('约每月 0 次');
    expect(soonCard).toContain('2026-10-17 11:15');
    expect(laterCard).toContain('2026-11-26 11:00');
  });

  it('renders weekday 不计调休, monthly count, and identity on the card', () => {
    const card = JSON.stringify(automationConfirmCard({
      taskType: 'reminder',
      name: '站会',
      taskText: '提醒站会',
      timezone: TZ,
      schedule: weekday(),
      now: NOW,
      confirmToken: 'auto_cb.v1.confirm',
      rejectToken: 'auto_cb.v1.reject',
    }));
    expect(card).toContain('工作日不计调休');
    expect(card).toContain('约每月');
    expect(card).toContain('本 bot 发送提醒（不跑 agent）');
    expect(card).toContain('auto.confirm');
    expect(card).toContain('是');
    expect(describeEnd(weekday(), TZ)).toMatch(/2026-11-16/);
    expect(describeIdentity('agent', '/tmp/ws')).toContain('已快照工作目录');
    expect(describeIdentity('agent', '/tmp/ws')).toContain('仅 bot 身份');
    expect(describeIdentity('agent')).toContain('纵深防御不是安全边界');
  });

  it('writes a future start under the schedule line and counts fires from that start', () => {
    const startAt = Date.UTC(2026, 9, 18, 7, 40);
    const endAt = Date.UTC(2026, 9, 18, 8, 5);
    const schedule: Schedule = {
      kind: 'interval',
      timezone: TZ,
      everyMs: 10 * 60_000,
      window: { from: { hour: 15, minute: 40 }, to: { hour: 16, minute: 5 } },
      startAt,
      endAt,
    };
    const card = confirmBody(schedule);
    const scheduleAt = card.indexOf('**时间表：**');
    const startLine = card.indexOf('从 2026-10-18 15:40 开始');
    const nextAt = card.indexOf('**接下来 3 次：**');
    expect(scheduleAt).toBeGreaterThanOrEqual(0);
    expect(startLine).toBeGreaterThan(scheduleAt);
    expect(nextAt).toBeGreaterThan(startLine);
    expect(card).toContain('2026-10-18 15:40');
    expect(card).not.toContain('2026-10-17 15:40');
  });

  it('omits the start line when the recurring rule already started', () => {
    expect(confirmBody(daily())).not.toMatch(/从 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 开始/);
  });
});

function confirmBody(schedule: Schedule): string {
  return JSON.stringify(automationConfirmCard({
    taskType: 'reminder',
    name: '一次性提醒',
    taskText: '只响一次',
    timezone: TZ,
    schedule,
    now: NOW,
    confirmToken: 'auto_cb.v1.confirm',
    rejectToken: 'auto_cb.v1.reject',
  }));
}

function daily(): Schedule {
  return {
    kind: 'daily',
    timezone: TZ,
    times: [{ hour: 9, minute: 0 }, { hour: 18, minute: 0 }],
    startAt: NOW,
    endAt: END,
  };
}

function weekday(): Schedule {
  return {
    kind: 'weekday',
    timezone: TZ,
    times: [{ hour: 9, minute: 30 }],
    startAt: NOW,
    endAt: END,
  };
}

function weekly(): Schedule {
  return {
    kind: 'weekly',
    timezone: TZ,
    weekdays: [1, 3],
    times: [{ hour: 10, minute: 0 }],
    startAt: NOW,
    endAt: END,
  };
}

function interval(): Schedule {
  return {
    kind: 'interval',
    timezone: TZ,
    everyMs: 60 * 60_000,
    window: { from: { hour: 9, minute: 0 }, to: { hour: 18, minute: 0 } },
    startAt: NOW,
    endAt: END,
  };
}
