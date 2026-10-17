import { describe, expect, it } from 'vitest';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import {
  automationBoardCard,
  chatStatusSnapshot,
  formatAutomationListLine,
} from '../../../src/automations/board-card';
import type { AutomationItem, AutomationsStatusSnapshot } from '../../../src/automations/store';

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
    lastStatus: 'ok',
    fireHistory: [],
    chatId: 'oc_group',
    createdBy: 'ou_alice',
    name: '交周报',
    taskText: 'secret ping body',
    missedInstants: [],
    ...overrides,
  };
}

describe('automation board card', () => {
  it('renders 暂无, missed rows, and a status block without task text or Feishu ids', () => {
    const auth = new BoardActionAuth({ secret: 'board-secret', now: () => FIRE });
    const empty = JSON.stringify(automationBoardCard({
      items: [],
      status: { v: 1, bot: 'Pin Bot', updatedAt: FIRE, items: [] },
      auth,
    }));
    expect(empty).toContain('暂无');
    expect(empty).toContain('本群自动化');
    expect(empty).toContain('notation');

    const live = item({
      missed: 2,
      missedInstants: [
        { fireAt: FIRE, recordedAt: FIRE },
        { fireAt: FIRE + 3_600_000, recordedAt: FIRE },
      ],
    });
    const status: AutomationsStatusSnapshot = {
      v: 1,
      bot: 'Pin Bot',
      updatedAt: FIRE,
      items: [{
        id: 1,
        paused: false,
        nextFireAt: FIRE,
        lastFireAt: 0,
        lastStatus: 'ok',
        endAt: FIRE,
        missed: 2,
      }],
    };
    const card = JSON.stringify(automationBoardCard({ items: [live], status, auth }));
    expect(card).toContain('已错过 原定 2026-01-02 12:00');
    expect(card).toContain('已错过 原定 2026-01-02 13:00');
    expect(card).toContain('暂停');
    expect(card).toContain('删除');
    expect(card).toContain('auto_board.v1.');
    expect(card).not.toContain('secret ping body');
    expect(card).not.toContain('ou_alice');
    expect(JSON.stringify(status)).not.toContain('oc_group');
    expect(formatAutomationListLine(live)).toContain('#1 交周报');
    expect(formatAutomationListLine(live)).toContain('提醒');
  });

  it('filters the A0c snapshot to this chat and keeps the file updatedAt', () => {
    const snapshot: AutomationsStatusSnapshot = {
      v: 1,
      bot: 'Pin Bot',
      updatedAt: 99,
      items: [
        { id: 1, paused: false, nextFireAt: 1, lastFireAt: 0, lastStatus: 'ok', endAt: 0, missed: 0 },
        { id: 2, paused: true, nextFireAt: 2, lastFireAt: 0, lastStatus: 'ok', endAt: 0, missed: 0 },
      ],
    };
    expect(chatStatusSnapshot(snapshot, [item({ id: 2 })], { bot: 'other', updatedAt: 1 })).toEqual({
      v: 1,
      bot: 'Pin Bot',
      updatedAt: 99,
      items: [snapshot.items[1]],
    });
  });
});
