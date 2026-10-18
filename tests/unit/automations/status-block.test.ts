import { describe, expect, it } from 'vitest';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import { automationBoardCard } from '../../../src/automations/board-card';
import {
  CATCH_UP_WINDOW_MS,
  isMissed,
  type Schedule,
} from '../../../src/automations/schedule';
import {
  simplifiedBoardRender,
  statusBlockIsMissed,
} from '../../../src/automations/status-block';
import type { AutomationItem } from '../../../src/automations/store';

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

describe('monitor status-block contract', () => {
  it('keeps the board human-only and matches Larkent isMissed for the same now', () => {
    const live = item();
    const now = FIRE + 1;
    const card = automationBoardCard({
      items: [live],
      auth: new BoardActionAuth({ secret: 'board-secret', now: () => now }),
    });
    const simplified = simplifiedBoardRender(card);
    expect(simplified).not.toContain('"v":1');
    expect(simplified).not.toMatch(/\{/);
    expect(simplified).not.toContain('auto_token');
    expect(simplified).not.toContain('secret ping body');
    expect(simplified).not.toContain('ou_alice');
    expect(simplified).not.toContain('oc_group');
    expect(JSON.stringify(card)).not.toContain('notation');

    const hookItem = {
      id: live.id,
      paused: live.paused,
      nextFireAt: live.nextFireAt,
      lastFireAt: live.lastFireAt,
    };
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
