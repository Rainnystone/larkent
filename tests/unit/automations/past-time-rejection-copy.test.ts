import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assessAutomationProposal,
  automationProposalSuffix,
  rejectMessage,
} from '../../../src/automations/command';
import { zonedLocalToUtc } from '../../../src/automations/zoned-time';

/**
 * Seams: the chat lines callers already send.
 * `rejectMessage` is the /auto and confirm reply. `automationProposalSuffix`
 * is the model-reply line. Together they catch a duplicated suggestion and a
 * hard-coded absolute date. They do not cover parser or schedule decisions.
 */

/** 2026-10-18 15:05 Asia/Shanghai. 00:30 that calendar day is already past. */
const PAST_NOW = Date.UTC(2026, 9, 18, 7, 5, 0);
/** 2026-10-17 11:00 Asia/Shanghai. */
const EARLIER_NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const TIMEZONE = 'Asia/Shanghai';

describe('past-time rejection copy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is one line with a single suggestion and no hard-coded date', () => {
    const verdict = assessAutomationProposal({
      taskType: 'reminder',
      scheduleText: '今天 00:30',
      now: PAST_NOW,
      timezone: TIMEZONE,
      hasCwd: true,
    });
    expect(verdict).toMatchObject({ outcome: 'reject', reason: 'past-time', clock: '00:30' });

    expect(rejectMessage('past-time', { clock: '00:30' })).toBe(
      '今天 00:30 已过，可改为「明天 00:30」。',
    );

    const reply = automationProposalSuffix(verdict, '今天 00:30');
    expect(reply).toBe('⚠️ 没有创建任务：今天 00:30 已过，可改为「明天 00:30」。');
    expect(reply).not.toContain('\n');
    expect(reply?.match(/明天/g)).toHaveLength(1);
    expect(reply).not.toContain('可写成');
    expect(reply).not.toContain('例如');
    expect(reply).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    const replace = automationProposalSuffix(verdict, {
      op: 'replace',
      id: 3,
      taskType: 'reminder',
      scheduleText: '今天 00:30',
      name: '名称',
      taskText: '正文',
    });
    expect(replace).toBe('⚠️ 没有替换任务：今天 00:30 已过，可改为「明天 00:30」。');
  });

  it('derives the absolute-date example from the injected now', () => {
    const earlier = rejectionExample(EARLIER_NOW);
    const later = rejectionExample(PAST_NOW);

    expect(earlier).toContain('「2026-10-18 15:50」');
    expect(later).toContain('「2026-10-19 15:50」');
    expect(later).not.toContain('2026-10-18');
    expect(absoluteExampleMs(earlier, TIMEZONE)).toBeGreaterThanOrEqual(EARLIER_NOW);
    expect(absoluteExampleMs(later, TIMEZONE)).toBeGreaterThanOrEqual(PAST_NOW);
  });
});

function rejectionExample(now: number): string {
  const verdict = assessAutomationProposal({
    taskType: 'reminder',
    scheduleText: '今天 15:50 运行一次',
    now,
    timezone: TIMEZONE,
    hasCwd: true,
  });
  expect(verdict).toMatchObject({ outcome: 'reject', reason: 'invalid-schedule' });
  const line = automationProposalSuffix(verdict, '今天 15:50 运行一次', {
    now,
    timezone: TIMEZONE,
  });
  if (line === undefined) throw new Error('rejection line missing');
  expect(line).toContain('⚠️ 没有创建任务：');
  expect(line).not.toContain('\n');
  return line;
}

function absoluteExampleMs(line: string, timezone: string): number {
  const match = line.match(/「(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})」/);
  expect(match).not.toBeNull();
  const [, year, month, day, hour, minute] = match ?? [];
  return zonedLocalToUtc(
    timezone,
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
  );
}
