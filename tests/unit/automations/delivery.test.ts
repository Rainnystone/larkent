import { describe, expect, it } from 'vitest';
import {
  fireTurnId,
  formatMissedNoticeText,
  formatReminderText,
  missedTurnId,
} from '../../../src/automations/delivery';
import { formatFireKey } from '../../../src/automations/schedule';
import { FEISHU_DELIVERY_ID_MAX_CHARS, replyDeliveryKey } from '../../../src/bot/turn-journal';

describe('automation outbox ids and copy', () => {
  it('keeps the longest realistic fire-key deliveryId unique, unclipped, and within 50 chars', () => {
    const fireAt = Date.UTC(2099, 11, 31, 23, 59);
    const longKey = formatFireKey(Number.MAX_SAFE_INTEGER, fireAt);
    const otherKey = formatFireKey(Number.MAX_SAFE_INTEGER, fireAt + 60_000);
    const fireId = replyDeliveryKey(fireTurnId(longKey));
    const otherId = replyDeliveryKey(fireTurnId(otherKey));
    const missedId = replyDeliveryKey(missedTurnId(Number.MAX_SAFE_INTEGER, [fireAt]));
    expect(fireId.length).toBeLessThanOrEqual(FEISHU_DELIVERY_ID_MAX_CHARS);
    expect(otherId.length).toBeLessThanOrEqual(FEISHU_DELIVERY_ID_MAX_CHARS);
    expect(missedId.length).toBeLessThanOrEqual(FEISHU_DELIVERY_ID_MAX_CHARS);
    expect(fireId).toBe(`reply:af:${longKey}`);
    expect(fireId).not.toBe(otherId);
    expect(fireId).not.toBe(missedId);
    expect(fireId).toBe(fireId.slice(0, FEISHU_DELIVERY_ID_MAX_CHARS));
  });

  it('formats on-time, catch-up, and missed copy from the task timezone', () => {
    const fireAt = Date.UTC(2026, 0, 2, 12, 0, 0);
    expect(formatReminderText({
      name: '交周报',
      taskText: '提醒交周报',
      catchUp: false,
      timezone: 'UTC',
      fireAt,
    })).toBe('⏰ 交周报：提醒交周报');
    expect(formatReminderText({
      name: '交周报',
      taskText: '提醒交周报',
      catchUp: true,
      timezone: 'UTC',
      fireAt,
    })).toBe('⏰ 交周报：提醒交周报（补跑，原定 12:00）');
    expect(formatMissedNoticeText({
      name: '交周报',
      timezone: 'UTC',
      missedFires: [fireAt, fireAt + 60 * 60_000],
    })).toBe('已错过：交周报\n原定 12:00\n原定 13:00');
  });
});
