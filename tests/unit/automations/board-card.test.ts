import { describe, expect, it } from 'vitest';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import { simplifiedBoardRender } from '../../../src/automations/status-block';
import {
  automationBoardCard,
  formatAutomationListLine,
} from '../../../src/automations/board-card';
import type { AutomationItem } from '../../../src/automations/store';

const FIRE = Date.UTC(2026, 0, 2, 12, 0, 0);

function item(overrides: Partial<AutomationItem> = {}): AutomationItem {
  return {
    id: 1,
    taskType: 'reminder',
    schedule: { kind: 'one-shot', fireAt: FIRE },
    timezone: 'UTC',
    startAt: FIRE - 60_000,
    endAt: FIRE,
    nextFireAt: FIRE,
    lastFireAt: 0,
    paused: false,
    missed: 0,
    lastStatus: 'never',
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

describe('automation board card', () => {
  it('renders 暂无 and missed rows without a machine-readable JSON note', () => {
    const auth = new BoardActionAuth({ secret: 'board-secret', now: () => FIRE });
    const emptyCard = automationBoardCard({ items: [], auth });
    const empty = JSON.stringify(emptyCard);
    expect(empty).toContain('暂无');
    expect(empty).toContain('本群自动化');
    expect(empty).not.toContain('notation');
    expect(simplifiedBoardRender(emptyCard)).not.toMatch(/\{/);

    const live = item({
      missed: 2,
      missedInstants: [
        { fireAt: FIRE, recordedAt: FIRE },
        { fireAt: FIRE + 3_600_000, recordedAt: FIRE },
      ],
    });
    const cardObj = automationBoardCard({ items: [live], auth });
    const card = JSON.stringify(cardObj);
    const visible = simplifiedBoardRender(cardObj);
    expect(card).toContain('已错过 原定 2026-01-02 12:00');
    expect(card).toContain('已错过 原定 2026-01-02 13:00');
    expect(card).toContain('暂停');
    expect(card).toContain('删除');
    expect(card).toContain('auto_board.');
    expect(card).not.toContain('secret ping body');
    expect(card).not.toContain('ou_alice');
    expect(card).not.toContain('"v":1');
    expect(card).not.toContain('"v":2');
    expect(visible).not.toMatch(/\{/);
    expect(visible).not.toContain('"id"');
    expect(formatAutomationListLine(live)).toContain('#1 交周报');
    expect(formatAutomationListLine(live)).toContain('提醒');
    expect(formatAutomationListLine(live)).toContain('尚未运行');
    expect(visible).toContain('尚未运行');
  });

  it('labels a never-fired task 尚未运行 and a successful last run 待触发', () => {
    const auth = new BoardActionAuth({ secret: 'board-secret', now: () => FIRE });
    const neverFired = item({ lastStatus: 'never', lastFireAt: 0 });
    const succeeded = item({ lastStatus: 'ok', lastFireAt: FIRE });
    expect(formatAutomationListLine(neverFired)).toContain('尚未运行');
    expect(formatAutomationListLine(neverFired)).not.toContain('待触发');
    expect(formatAutomationListLine(succeeded)).toContain('待触发');
    expect(formatAutomationListLine(succeeded)).not.toContain('尚未运行');
    expect(simplifiedBoardRender(automationBoardCard({ items: [neverFired], auth }))).toContain('尚未运行');
    expect(simplifiedBoardRender(automationBoardCard({ items: [succeeded], auth }))).toContain('待触发');
    expect(formatAutomationListLine(item({ paused: true, lastStatus: 'never' }))).toContain('已暂停');
  });
});
