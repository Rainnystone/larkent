import { describe, expect, it } from 'vitest';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import { automationBoardCard } from '../../../src/automations/board-card';
import { automationConfirmCard } from '../../../src/automations/confirm-card';
import { automationSettledCard } from '../../../src/automations/draft-confirmation/settlement';
import { automationEndCard, type EndCardTokens } from '../../../src/automations/end-card';
import type { AutomationItem } from '../../../src/automations/store';
import { assertCardSchema2 } from '../../helpers/card-schema2';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const END = NOW + 30 * 24 * 60 * 60 * 1000;

const TOKENS: EndCardTokens = {
  'auto.end.1w': 'auto_cb.v1.1w',
  'auto.end.2w': 'auto_cb.v1.2w',
  'auto.end.1m': 'auto_cb.v1.1m',
  'auto.end.3m': 'auto_cb.v1.3m',
  'auto.end.eoy': 'auto_cb.v1.eoy',
  'auto.end.1y': 'auto_cb.v1.1y',
  'auto.end.custom': 'auto_cb.v1.custom',
  'auto.reject': 'auto_cb.v1.reject',
};

describe('automation cards are CardKit schema 2.0', () => {
  it('accepts confirm, end, empty, paused, missed, and skipped boards', () => {
    assertCardSchema2(automationConfirmCard({
      taskType: 'reminder',
      name: '站会',
      taskText: '提醒站会',
      timezone: TZ,
      schedule: {
        kind: 'weekday',
        timezone: TZ,
        times: [{ hour: 9, minute: 30 }],
        startAt: NOW,
        endAt: END,
      },
      now: NOW,
      confirmToken: 'auto_cb.v1.confirm',
      rejectToken: 'auto_cb.v1.reject',
    }));

    assertCardSchema2(automationSettledCard('已确认 #1'));
    assertCardSchema2(automationSettledCard('已取消'));
    assertCardSchema2(automationSettledCard('已过期'));
    assertCardSchema2(automationSettledCard('已指定结束时间'));

    const end = automationEndCard(TOKENS);
    assertCardSchema2(end);
    const form = findTagged(end, 'form');
    expect(form, 'custom end_at lives in a form').toBeDefined();
    const formJson = JSON.stringify(form);
    expect(formJson).toContain('"name":"end_at"');
    expect(formJson).toContain('auto.end.custom');
    expect(formJson).toContain('"form_action_type":"submit"');
    const outside = JSON.stringify(end).replace(formJson, '');
    expect(outside).toContain('auto.end.1w');
    expect(outside).toContain('auto.end.2w');
    expect(outside).toContain('auto.end.1m');
    expect(outside).toContain('auto.end.3m');
    expect(outside).toContain('auto.end.eoy');
    expect(outside).toContain('auto.end.1y');
    expect(outside).toContain('auto.reject');

    const auth = new BoardActionAuth({ secret: 'board-secret', now: () => NOW });
    const board = automationBoardCard({
      items: [],
      auth,
    });
    assertCardSchema2(board);
    expect((board as { config?: { update_multi?: boolean } }).config?.update_multi).toBe(true);
    assertCardSchema2(automationBoardCard({
      items: [item({ paused: true, lastStatus: 'ok' })],
      auth,
    }));
    assertCardSchema2(automationBoardCard({
      items: [item({
        missedInstants: [{ fireAt: NOW, recordedAt: NOW }],
        skippedInstants: [{ fireAt: NOW + 60_000, recordedAt: NOW, reason: 'previous-run-unsettled' }],
      })],
      auth,
    }));
  });
});

function item(overrides: Partial<AutomationItem> = {}): AutomationItem {
  return {
    id: 1,
    taskType: 'reminder',
    schedule: { kind: 'one-shot', fireAt: NOW },
    timezone: 'UTC',
    startAt: NOW - 60_000,
    endAt: NOW,
    nextFireAt: NOW,
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

function findTagged(node: unknown, tag: string): unknown {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findTagged(entry, tag);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const rec = node as Record<string, unknown>;
  if (rec.tag === tag) return rec;
  for (const value of Object.values(rec)) {
    const found = findTagged(value, tag);
    if (found) return found;
  }
  return undefined;
}
