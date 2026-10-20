import { describe, expect, it } from 'vitest';
import {
  automationConfirmCard,
  automationReplaceCard,
  describeEnd,
  describeIdentity,
  describeSchedule,
  formatZonedDateTime,
} from '../../../src/automations/confirm-card';
import { nextFires, type Schedule } from '../../../src/automations/schedule';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const END = NOW + 30 * 24 * 60 * 60 * 1000;

describe('confirm card copy', () => {
  it('explains replacement, the original schedule, and the number change on confirmation', () => {
    const card = automationReplaceCard({
      target: {
        id: 1,
        name: '原提醒',
        taskType: 'reminder',
        scheduleLabel: '每天 10:00',
        nextFireLabel: '2026-10-18 10:00',
        endLabel: '2026-11-16 11:00',
      },
      taskType: 'reminder',
      name: '新提醒',
      taskText: '提醒检查进度',
      timezone: TZ,
      schedule: {
        kind: 'daily',
        timezone: TZ,
        times: [{ hour: 11, minute: 0 }],
        startAt: NOW,
        endAt: END,
      },
      now: NOW,
      confirmToken: 'auto_cb.v1.confirm',
      rejectToken: 'auto_cb.v1.reject',
    });
    const body = JSON.stringify((card as { body: object }).body);
    expect(body).not.toContain('将删除');
    expect(body).toContain('替换：#1 原提醒 · 每天 10:00 → 新设置如下');
    expect(body).toContain('确认后原 #1 将由新编号取代');
    expect(body).toContain('每天 11:00');
    expect(card).toMatchObject({
      header: { title: { content: '确认替换 #1' } },
      config: { summary: { content: '确认替换 #1' } },
    });
  });

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

  it('renders weekday 不计调休, exact remaining count, and identity on the card', () => {
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
    expect(card).toContain('共 21 次');
    expect(card).not.toContain('约每月');
    expect(card).toContain('本 bot 发送提醒（不跑 agent）');
    expect(card).toContain('auto.confirm');
    expect(card).toContain('是');
    expect(describeEnd(weekday(), TZ)).toMatch(/2026-11-16/);
    expect(describeIdentity('agent', '/tmp/ws')).toContain('已快照工作目录');
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

  it('writes a one-shot as its single fire time and never as the next three', () => {
    const now = Date.UTC(2026, 9, 18, 7, 7, 0);
    const markdown = cardMarkdown({ kind: 'one-shot', fireAt: Date.UTC(2026, 9, 18, 7, 52, 0) }, now);
    expect(markdown).not.toContain('接下来');
    expect(markdown).toContain('触发时间：2026-10-18 15:52（共 1 次）');
    expect(markdown).not.toContain('约每月');
    expect(markdown.split('共 1 次')).toHaveLength(2);
  });

  it('labels one or two remaining fires with that many lines', () => {
    const endAt = Date.UTC(2026, 9, 18, 8, 5, 0);
    const two = cardMarkdown(windowInterval(Date.UTC(2026, 9, 18, 7, 40, 0), endAt), Date.UTC(2026, 9, 18, 7, 45, 0));
    expect(listedFires(two)).toEqual({
      count: 2,
      lines: ['- 2026-10-18 15:50', '- 2026-10-18 16:00'],
    });
    expect(two).not.toContain('接下来 3 次');

    const one = cardMarkdown(windowInterval(Date.UTC(2026, 9, 18, 7, 40, 0), endAt), Date.UTC(2026, 9, 18, 7, 52, 0));
    expect(listedFires(one)).toEqual({
      count: 1,
      lines: ['- 2026-10-18 16:00'],
    });
    expect(one).not.toContain('接下来 3 次');
  });

  it('keeps three upcoming lines and the exact weekday total through year end', () => {
    const schedule = weekdayUntil(Date.UTC(2026, 11, 31, 16, 0, 0));
    const markdown = cardMarkdown(schedule);
    const fires = nextFires(schedule, NOW, 3).map((fireAt) => `- ${formatZonedDateTime(TZ, fireAt)}`);
    expect(fires).toEqual(['- 2026-10-19 09:00', '- 2026-10-20 09:00', '- 2026-10-21 09:00']);
    expect(listedFires(markdown)).toEqual({ count: 3, lines: fires });
    expect(markdown.split('\n\n')).toContain('共 54 次');
    expect(markdown).not.toContain('约每月');
  });

  it('uses the one remaining 16:00 fire for the short afternoon window', () => {
    const now = Date.UTC(2026, 9, 18, 7, 52, 0);
    const markdown = cardMarkdown(windowInterval(now, Date.UTC(2026, 9, 18, 8, 5, 0)), now);
    expect(listedFires(markdown)).toEqual({
      count: 1,
      lines: ['- 2026-10-18 16:00'],
    });
    expect(markdown.split('\n\n')).toContain('共 1 次');
    expect(markdown).not.toContain('约每月');
  });

  it('counts every remaining fire in an eight-day daily window', () => {
    const schedule: Schedule = {
      kind: 'daily',
      timezone: TZ,
      times: [{ hour: 9, minute: 0 }],
      startAt: NOW,
      endAt: Date.UTC(2026, 9, 25, 3, 0, 0),
    };
    const counted = nextFires(schedule, NOW, 100);
    expect(counted.map((fireAt) => formatZonedDateTime(TZ, fireAt))).toEqual([
      '2026-10-18 09:00',
      '2026-10-19 09:00',
      '2026-10-20 09:00',
      '2026-10-21 09:00',
      '2026-10-22 09:00',
      '2026-10-23 09:00',
      '2026-10-24 09:00',
      '2026-10-25 09:00',
    ]);
    const markdown = cardMarkdown(schedule);
    expect(listedFires(markdown)).toEqual({
      count: 3,
      lines: counted.slice(0, 3).map((fireAt) => `- ${formatZonedDateTime(TZ, fireAt)}`),
    });
    expect(markdown.split('\n\n')).toContain('共 8 次');
    expect(markdown).not.toContain('约每月');
  });

  it('counts a future start instant in the remaining total', () => {
    const startAt = Date.UTC(2026, 9, 18, 7, 40);
    const schedule = windowInterval(startAt, Date.UTC(2026, 9, 18, 8, 5));
    const markdown = cardMarkdown(schedule);
    expect(listedFires(markdown).lines).toEqual([
      '- 2026-10-18 15:40',
      '- 2026-10-18 15:50',
      '- 2026-10-18 16:00',
    ]);
    expect(markdown.split('\n\n')).toContain('共 3 次');
    expect(markdown).not.toContain('约每月');
  });

  it('counts 31 daily 09:00 fires in the Oct 22–Nov 22 Shanghai month window', () => {
    const markdown = cardMarkdown(dailyAtNine(
      Date.UTC(2026, 9, 21, 16, 0, 0),
      Date.UTC(2026, 10, 21, 16, 0, 0),
    ), Date.UTC(2026, 9, 19, 0, 0, 0));
    expect(markdown).toContain('从 2026-10-22 00:00 开始');
    expect(markdown.split('\n\n')).toContain('共 31 次');
    expect(markdown).not.toContain('约每月');
  });

  it('counts 28, 29, 30, and 31 daily fires on those month lengths', () => {
    const now = Date.UTC(2026, 0, 15, 0, 0, 0);
    expect(cardMarkdown(dailyAtNine(
      Date.UTC(2026, 0, 31, 16, 0, 0),
      Date.UTC(2026, 1, 28, 16, 0, 0),
    ), now).split('\n\n')).toContain('共 28 次');
    expect(cardMarkdown(dailyAtNine(
      Date.UTC(2028, 0, 31, 16, 0, 0),
      Date.UTC(2028, 1, 29, 16, 0, 0),
    ), now).split('\n\n')).toContain('共 29 次');
    expect(cardMarkdown(dailyAtNine(
      Date.UTC(2026, 2, 31, 16, 0, 0),
      Date.UTC(2026, 3, 30, 16, 0, 0),
    ), now).split('\n\n')).toContain('共 30 次');
    expect(cardMarkdown(dailyAtNine(
      Date.UTC(2025, 11, 31, 16, 0, 0),
      Date.UTC(2026, 0, 31, 16, 0, 0),
    ), Date.UTC(2025, 11, 15, 0, 0, 0)).split('\n\n')).toContain('共 31 次');
  });

  it('excludes a daily fire that lands exactly on endAt', () => {
    const markdown = cardMarkdown(dailyAtNine(
      Date.UTC(2026, 9, 22, 1, 0, 0),
      Date.UTC(2026, 10, 22, 1, 0, 0),
    ), Date.UTC(2026, 9, 19, 0, 0, 0));
    expect(markdown.split('\n\n')).toContain('共 31 次');
    expect(markdown).not.toContain('共 32 次');
  });

  it('counts weekday, weekly, and interval windows from a future start', () => {
    const now = Date.UTC(2026, 9, 17, 3, 0, 0);
    const weekdayMarkdown = cardMarkdown({
      kind: 'weekday',
      timezone: TZ,
      times: [{ hour: 9, minute: 0 }],
      startAt: Date.UTC(2026, 9, 21, 16, 0, 0),
      endAt: Date.UTC(2026, 10, 21, 16, 0, 0),
    }, now);
    expect(weekdayMarkdown).toContain('从 2026-10-22 00:00 开始');
    expect(weekdayMarkdown.split('\n\n')).toContain('共 22 次');

    const weeklyMarkdown = cardMarkdown({
      kind: 'weekly',
      timezone: TZ,
      weekdays: [1],
      times: [{ hour: 10, minute: 0 }],
      startAt: Date.UTC(2026, 9, 18, 16, 0, 0),
      endAt: Date.UTC(2026, 10, 15, 16, 0, 0),
    }, now);
    expect(weeklyMarkdown.split('\n\n')).toContain('共 4 次');

    const intervalMarkdown = cardMarkdown({
      kind: 'interval',
      timezone: TZ,
      everyMs: 60 * 60_000,
      window: { from: { hour: 9, minute: 0 }, to: { hour: 12, minute: 0 } },
      startAt: Date.UTC(2026, 9, 21, 16, 0, 0),
      endAt: Date.UTC(2026, 9, 23, 16, 0, 0),
    }, now);
    expect(intervalMarkdown.split('\n\n')).toContain('共 6 次');
  });

  it('caps a pathological horizon instead of counting forever', () => {
    const startAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    const markdown = cardMarkdown({
      kind: 'interval',
      timezone: TZ,
      everyMs: 10 * 60_000,
      startAt,
      endAt: startAt + 2 * 365 * 24 * 60 * 60_000,
    }, startAt);
    expect(markdown.split('\n\n')).toContain('超过 52560 次 · 约每月 4464 次');
    expect(markdown).not.toMatch(/共 \d+ 次/);
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

function cardMarkdown(schedule: Schedule, now = NOW): string {
  const card = automationConfirmCard({
    taskType: 'reminder',
    name: '提醒',
    taskText: '到点提醒',
    timezone: TZ,
    schedule,
    now,
    confirmToken: 'auto_cb.v1.confirm',
    rejectToken: 'auto_cb.v1.reject',
  }) as { body?: { elements?: Array<{ tag?: string; content?: string }> } };
  return (card.body?.elements ?? [])
    .filter((element) => element.tag === 'markdown' && typeof element.content === 'string')
    .map((element) => element.content ?? '')
    .join('\n');
}

function listedFires(markdown: string): { count: number; lines: string[] } {
  const match = markdown.match(/\*\*接下来 (\d+) 次：\*\*\n((?:- [^\n]+\n?)*)/);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error(`missing upcoming fires in: ${markdown}`);
  }
  return {
    count: Number(match[1]),
    lines: match[2].split('\n').filter((line) => line.startsWith('- ')),
  };
}

function dailyAtNine(startAt: number, endAt: number): Schedule {
  return {
    kind: 'daily',
    timezone: TZ,
    times: [{ hour: 9, minute: 0 }],
    startAt,
    endAt,
  };
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

function weekdayUntil(endAt: number): Schedule {
  return {
    kind: 'weekday',
    timezone: TZ,
    times: [{ hour: 9, minute: 0 }],
    startAt: NOW,
    endAt,
  };
}

function windowInterval(startAt: number, endAt: number): Schedule {
  return {
    kind: 'interval',
    timezone: TZ,
    everyMs: 10 * 60_000,
    window: { from: { hour: 15, minute: 40 }, to: { hour: 16, minute: 5 } },
    startAt,
    endAt,
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
