import { describe, expect, it } from 'vitest';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import { automationBoardCard } from '../../../src/automations/board-card';
import {
  CATCH_UP_WINDOW_MS,
  isMissed,
  type Schedule,
} from '../../../src/automations/schedule';
import {
  parseStatusBlock,
  simplifiedBoardRender,
  statusBlockIsMissed,
} from '../../../src/automations/status-block';
import type { AutomationItem, AutomationsStatusSnapshot } from '../../../src/automations/store';

const FIRE = Date.UTC(2026, 0, 2, 12, 0, 0);
const SCHEDULE: Schedule = { kind: 'one-shot', fireAt: FIRE };

function item(overrides: Partial<AutomationItem> = {}): AutomationItem {
  return {
    id: 3,
    taskType: 'reminder',
    schedule: SCHEDULE,
    timezone: 'UTC',
    startAt: FIRE - 20 * 60_000,
    endAt: FIRE,
    nextFireAt: FIRE,
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

function snapshotFor(live: AutomationItem, now: number): AutomationsStatusSnapshot {
  return {
    v: 1,
    bot: 'Grok Bot',
    updatedAt: now,
    items: [{
      id: live.id,
      paused: live.paused,
      nextFireAt: live.nextFireAt,
      lastFireAt: live.lastFireAt,
      lastStatus: live.lastStatus,
      endAt: live.endAt,
      missed: live.missed,
    }],
  };
}

describe('monitor status-block contract', () => {
  it('parses v1 from the simplified board render and matches Larkent isMissed for the same now', () => {
    const live = item();
    const now = FIRE + 1;
    const card = automationBoardCard({
      items: [live],
      status: snapshotFor(live, now),
      auth: new BoardActionAuth({ secret: 'board-secret', now: () => now }),
    });
    const simplified = simplifiedBoardRender(card);
    expect(simplified).toContain('"v":1');
    expect(simplified).toContain('"id":3');
    expect(simplified).not.toContain('auto_token');
    expect(simplified).not.toContain('secret ping body');
    expect(simplified).not.toContain('ou_alice');
    expect(simplified).not.toContain('oc_group');

    const parsed = parseStatusBlock(simplified);
    expect(parsed?.v).toBe(1);
    expect(parsed?.bot).toBe('Grok Bot');
    expect(parsed?.items).toEqual([
      {
        id: 3,
        paused: false,
        nextFireAt: FIRE,
        lastFireAt: 0,
        lastStatus: 'ok',
        endAt: FIRE,
        missed: 0,
      },
    ]);

    const hookItem = parsed!.items[0]!;
    const cases = [
      { name: 'now == nextFireAt', at: FIRE },
      { name: 'just after nextFireAt', at: FIRE + 1 },
      { name: 'exactly 24 h', at: FIRE + CATCH_UP_WINDOW_MS },
      { name: 'older than 24 h', at: FIRE + CATCH_UP_WINDOW_MS + 1 },
    ];
    for (const entry of cases) {
      const specMiss = !hookItem.paused
        && hookItem.nextFireAt > 0
        && entry.at > hookItem.nextFireAt
        && hookItem.lastFireAt < hookItem.nextFireAt;
      expect(isMissed({
        id: live.id,
        paused: live.paused,
        nextFireAt: live.nextFireAt,
        lastFireAt: live.lastFireAt,
        schedule: SCHEDULE,
      }, entry.at), entry.name).toBe(specMiss);
      expect(statusBlockIsMissed(hookItem, entry.at), entry.name).toBe(specMiss);
    }

    expect(statusBlockIsMissed({ ...hookItem, paused: true }, FIRE + 1)).toBe(false);
    expect(statusBlockIsMissed({ ...hookItem, lastFireAt: FIRE }, FIRE + 1)).toBe(false);
    expect(statusBlockIsMissed({ ...hookItem, nextFireAt: 0 }, FIRE + 1)).toBe(false);
  });
});
