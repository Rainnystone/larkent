import { describe, expect, it } from 'vitest';
import {
  STATUS_PUSH_MAX_NEXT_FIRES,
  STATUS_PUSH_WINDOW_MS,
  buildStatusPushPayload,
  signStatusPush,
  statusPushNextFires,
} from '../../../src/automations/status-push';
import type { AutomationItem } from '../../../src/automations/store';

const SECRET = 'unit-status-secret';
const PROFILE = 'test-profile';
const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const BOT_KEY = '611cd1b70c6aa4194f9d88d65f205310';
const ITEM_ID_1 = 'fafd7a45893c01126af17505798c534e';
const SIGNATURE = '5b352949761a5dd3246ab47300baf531e11a84ef4d4c46902d44bea544c075d0';
const SIGNATURE_FLIPPED = '3dd1f216e2e548882f5f7c0d077c54a593837ac8d085b88596ca9a77264a5783';

function item(overrides: Partial<AutomationItem> = {}): AutomationItem {
  return {
    id: 1,
    taskType: 'reminder',
    schedule: {
      kind: 'interval',
      timezone: 'UTC',
      everyMs: HOUR,
      startAt: NOW,
      endAt: NOW + 365 * DAY,
    },
    timezone: 'UTC',
    startAt: NOW,
    endAt: NOW + 365 * DAY,
    nextFireAt: NOW + HOUR,
    lastFireAt: 0,
    paused: false,
    missed: 0,
    lastStatus: 'ok',
    fireHistory: [],
    chatId: 'oc_group',
    createdBy: 'ou_alice',
    name: '交周报',
    taskText: 'secret ping body',
    missedInstants: [],
    skippedInstants: [],
    ...overrides,
  };
}

function monitorMisses(
  entry: { nextFires: number[]; lastFireAt: number; paused: boolean },
  now: number,
  scanSlack = 2 * 60_000,
): boolean {
  if (entry.paused) return false;
  const uncovered = entry.nextFires.filter((time) => time > entry.lastFireAt);
  if (uncovered.length === 0) {
    const pastUncovered = entry.nextFires.filter((time) => time <= now && time > entry.lastFireAt);
    if (pastUncovered.length === 0) return false;
    return now > Math.min(...pastUncovered) + scanSlack;
  }
  return now > Math.min(...uncovered) + scanSlack;
}

describe('status push payload', () => {
  it('signs HMAC-SHA256(secret, timestamp + "." + body) as a stable hex digest', () => {
    const timestamp = '1760000000000';
    const body = '{"v":2,"botKey":"x","updatedAt":1,"items":[]}';
    expect(signStatusPush(SECRET, timestamp, body)).toBe(SIGNATURE);
    expect(signStatusPush(SECRET, timestamp, '{"v":2,"botKey":"y","updatedAt":1,"items":[]}')).toBe(
      SIGNATURE_FLIPPED,
    );
    expect(signStatusPush(SECRET, timestamp, body)).not.toBe(
      signStatusPush(SECRET, timestamp, `${body} `),
    );
  });

  it('emits v2 with opaque botKey/id and none of the company fields', () => {
    expect(STATUS_PUSH_MAX_NEXT_FIRES).toBe(24);
    const payload = buildStatusPushPayload({
      secret: SECRET,
      profile: PROFILE,
      updatedAt: NOW,
      now: NOW,
      items: [item({
        chatId: 'oc_group',
        createdBy: 'ou_alice',
        name: '交周报',
        taskText: 'secret ping body',
      })],
    });
    expect(payload).toEqual({
      v: 2,
      botKey: BOT_KEY,
      updatedAt: NOW,
      items: [{
        id: ITEM_ID_1,
        nextFires: Array.from({ length: 24 }, (_, index) => NOW + (index + 1) * HOUR),
        lastFireAt: 0,
        paused: false,
        endAt: NOW + 365 * DAY,
      }],
    });
    const raw = JSON.stringify(payload);
    expect(raw).not.toMatch(/\b(oc|ou|om|on|cli)_/);
    expect(raw).not.toContain('oc_group');
    expect(raw).not.toContain('ou_alice');
    expect(raw).not.toContain('交周报');
    expect(raw).not.toContain('secret ping body');
    expect(raw).not.toContain('Grok Bot');
    expect(raw).not.toContain('Pin Bot');
    expect(raw).not.toContain('interval');
    expect(raw).not.toContain('everyMs');
    expect(raw).not.toContain('createdBy');
    expect(raw).not.toContain(PROFILE);
  });

  it('keeps nextFires after now, caps the 24h window at N, and still lists a weekly fire beyond 24h', () => {
    const hourlyFires = statusPushNextFires(item({ nextFireAt: NOW + 10 * 60_000 }), NOW);
    expect(hourlyFires).toHaveLength(STATUS_PUSH_MAX_NEXT_FIRES);
    expect(hourlyFires[0]).toBe(NOW + HOUR);
    expect(hourlyFires.at(-1)).toBe(NOW + STATUS_PUSH_MAX_NEXT_FIRES * HOUR);
    expect(hourlyFires.every((time) => time > NOW)).toBe(true);
    expect(hourlyFires.at(-1)!).toBeLessThanOrEqual(NOW + STATUS_PUSH_WINDOW_MS);

    const weeklyNext = NOW + 7 * DAY;
    const weekly = statusPushNextFires(item({
      schedule: {
        kind: 'weekly',
        timezone: 'UTC',
        weekdays: [5],
        times: [{ hour: 12, minute: 0 }],
        startAt: NOW,
        endAt: NOW + 365 * DAY,
      },
      nextFireAt: weeklyNext,
    }), NOW + 60_000);
    expect(weekly).toEqual([weeklyNext]);
    expect(weekly[0]! - NOW).toBeGreaterThan(STATUS_PUSH_WINDOW_MS);

    expect(statusPushNextFires(item({ paused: true, nextFireAt: NOW + HOUR }), NOW)).toEqual([]);
    expect(statusPushNextFires(item({ nextFireAt: 0 }), NOW)).toEqual([]);
  });

  it('does not evaluate as a monitor miss after a normal fire start', () => {
    const fireAt = NOW;
    const payload = buildStatusPushPayload({
      secret: SECRET,
      profile: PROFILE,
      updatedAt: fireAt,
      now: fireAt,
      items: [item({
        lastFireAt: fireAt,
        nextFireAt: fireAt + HOUR,
        lastStatus: 'ok',
      })],
    });
    const entry = payload.items[0]!;
    expect(entry.lastFireAt).toBe(fireAt);
    expect(entry.nextFires[0]).toBe(fireAt + HOUR);
    expect(monitorMisses(entry, fireAt)).toBe(false);
    expect(monitorMisses(entry, fireAt + 1)).toBe(false);
    expect(monitorMisses(entry, fireAt + 2 * 60_000)).toBe(false);
  });
});
