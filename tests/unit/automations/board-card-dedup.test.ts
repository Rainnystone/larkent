import { afterEach, describe, expect, it } from 'vitest';
import { automationBoardCard } from '../../../src/automations/board-card';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import type { AutomationItem } from '../../../src/automations/store';
import { cardButtonValue } from '../../helpers/card-button-value';
import { sdkCardClickRig, sortedKeys } from '../../helpers/sdk-card-click';

const CHAT = 'oc_752b8bb8cca2d789ba269f34ae8c1372';
const OPERATOR = 'ou_operator';
const BOARD_MESSAGE = 'om_board';
const FIRE = Date.UTC(2026, 0, 2, 12, 0, 0);

const rigs: Array<{ dispose(): Promise<unknown> }> = [];

afterEach(async () => {
  for (const next of rigs.splice(0)) await next.dispose();
});

function rig() {
  const sdk = sdkCardClickRig({ chatId: CHAT, operatorOpenId: OPERATOR, messageId: BOARD_MESSAGE });
  rigs.push(sdk);
  const received: string[] = [];
  const click = async (value: Record<string, unknown>) => {
    await sdk.click({ value });
    received.splice(0, received.length, ...sdk.received.map((entry) => String(entry.cmd)));
  };
  return { received, click };
}

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
    chatId: CHAT,
    createdBy: 'ou_alice',
    name: '交周报',
    taskText: 'secret ping body',
    missedInstants: [],
    skippedInstants: [],
    ...overrides,
  };
}

function render(paused: boolean): object {
  const auth = new BoardActionAuth({ secret: 'board-secret', now: () => FIRE });
  return automationBoardCard({ items: [item({ paused })], auth });
}

describe.each([
  { name: 'as rendered', order: (value: Record<string, unknown>) => value },
  { name: 'keys sorted', order: sortedKeys },
])('board card click dedup ($name)', ({ order }) => {
  it('pause then resume of the same item on one board message both reach the handler', async () => {
    const { received, click } = rig();
    const live = render(false);
    const paused = render(true);
    await click(order(cardButtonValue(live, 'auto.pause')));
    await click(order(cardButtonValue(paused, 'auto.resume')));
    expect(received).toEqual(['auto.pause', 'auto.resume']);
  });

  it('pause, resume, then pause again across re-renders all reach the handler', async () => {
    const { received, click } = rig();
    const live = render(false);
    const paused = render(true);
    const relive = render(false);
    await click(order(cardButtonValue(live, 'auto.pause')));
    await click(order(cardButtonValue(paused, 'auto.resume')));
    await click(order(cardButtonValue(relive, 'auto.pause')));
    expect(received).toEqual(['auto.pause', 'auto.resume', 'auto.pause']);
  });

  it('pause and delete from one render both reach the handler', async () => {
    const { received, click } = rig();
    const live = render(false);
    await click(order(cardButtonValue(live, 'auto.pause')));
    await click(order(cardButtonValue(live, 'auto.delete')));
    expect(received).toEqual(['auto.pause', 'auto.delete']);
  });

  it('an exact redelivery of one click is still dropped', async () => {
    const { received, click } = rig();
    const live = render(false);
    const pause = order(cardButtonValue(live, 'auto.pause'));
    await click(pause);
    await click(pause);
    expect(received).toEqual(['auto.pause']);
  });
});
