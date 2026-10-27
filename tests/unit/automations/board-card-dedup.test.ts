import { createLarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { automationBoardCard } from '../../../src/automations/board-card';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import type { AutomationItem } from '../../../src/automations/store';
import { cardButtonValue } from '../../helpers/card-button-value';

const CHAT = 'oc_752b8bb8cca2d789ba269f34ae8c1372';
const OPERATOR = 'ou_operator';
const BOARD_MESSAGE = 'om_board';
const FIRE = Date.UTC(2026, 0, 2, 12, 0, 0);

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
};

type ChannelInternals = {
  registerDispatcherHandlers(): void;
  builtinHandlers: Record<string, (raw: unknown) => Promise<unknown>>;
  safety: { dispose(): Promise<void> };
};

const channels: ChannelInternals[] = [];

afterEach(async () => {
  for (const internals of channels.splice(0)) {
    await internals.safety.dispose().catch(() => {});
  }
});

function freshCache() {
  const values = new Map<string, { value: unknown; expire?: number }>();
  return {
    async get(key: string | symbol, options?: { namespace?: string }) {
      const storageKey = `${options?.namespace ?? ''}:${String(key)}`;
      const entry = values.get(storageKey);
      if (!entry) return undefined;
      if (entry.expire !== undefined && entry.expire <= Date.now()) {
        values.delete(storageKey);
        return undefined;
      }
      return entry.value;
    },
    async set(key: string | symbol, value: unknown, expire?: number, options?: { namespace?: string }) {
      values.set(`${options?.namespace ?? ''}:${String(key)}`, { value, expire });
      return true;
    },
  };
}

function rig() {
  const received: string[] = [];
  const channel = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'test',
    logger: silentLogger as never,
    cache: freshCache() as never,
    safety: { chatQueue: { enabled: false } },
  });
  channel.on('cardAction', (evt) => {
    const value = evt.action.value as Record<string, unknown> | undefined;
    received.push(String(value?.cmd));
  });
  const internals = channel as unknown as ChannelInternals;
  internals.registerDispatcherHandlers();
  channels.push(internals);
  const trigger = internals.builtinHandlers['card.action.trigger']!;
  const click = (value: Record<string, unknown>) => trigger({
    operator: { open_id: OPERATOR },
    context: { open_message_id: BOARD_MESSAGE, open_chat_id: CHAT },
    action: { tag: 'button', value },
  });
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

function sortedKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
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
