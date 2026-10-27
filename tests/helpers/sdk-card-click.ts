import { createLarkChannel } from '@larksuite/channel';

export interface CallbackButton {
  name?: string;
  value: Record<string, unknown>;
}

/** Every callback button in a rendered card: v1 `button.value` and v2 `behaviors[].value`. */
export function callbackButtons(card: unknown): CallbackButton[] {
  const found: CallbackButton[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (rec.tag === 'button') {
      const name = typeof rec.name === 'string' ? rec.name : undefined;
      const values = Array.isArray(rec.behaviors)
        ? rec.behaviors
          .filter((behavior) => (behavior as { type?: unknown }).type === 'callback')
          .map((behavior) => (behavior as { value?: unknown }).value)
        : [rec.value];
      for (const value of values) {
        if (value && typeof value === 'object') found.push({ ...(name ? { name } : {}), value: value as Record<string, unknown> });
      }
    }
    for (const value of Object.values(rec)) walk(value);
  };
  walk(card);
  return found;
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };

type ChannelInternals = {
  registerDispatcherHandlers(): void;
  builtinHandlers: Record<string, (raw: unknown) => Promise<unknown>>;
  safety: { dispose(): Promise<void> };
};

function freshCache() {
  const values = new Map<string, { value: unknown; expire?: number }>();
  return {
    async get(key: string | symbol, options?: { namespace?: string }) {
      const entry = values.get(`${options?.namespace ?? ''}:${String(key)}`);
      if (!entry || (entry.expire !== undefined && entry.expire <= Date.now())) return undefined;
      return entry.value;
    },
    async set(key: string | symbol, value: unknown, expire?: number, options?: { namespace?: string }) {
      values.set(`${options?.namespace ?? ''}:${String(key)}`, { value, expire });
      return true;
    },
  };
}

/**
 * Drives clicks through the real @larksuite/channel `card.action.trigger`
 * handler so its dedup id and seen-cache decide what reaches our handler.
 */
export function sdkCardClickRig(input: { chatId: string; operatorOpenId: string; messageId: string }) {
  const received: Array<Record<string, unknown>> = [];
  const channel = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'test',
    logger: silentLogger as never,
    cache: freshCache() as never,
    safety: { chatQueue: { enabled: false } },
  });
  channel.on('cardAction', (evt) => {
    received.push((evt.action.value ?? {}) as Record<string, unknown>);
  });
  const internals = channel as unknown as ChannelInternals;
  internals.registerDispatcherHandlers();
  const trigger = internals.builtinHandlers['card.action.trigger']!;
  const click = (button: CallbackButton) => trigger({
    operator: { open_id: input.operatorOpenId },
    context: { open_message_id: input.messageId, open_chat_id: input.chatId },
    action: { tag: 'button', ...(button.name ? { name: button.name } : {}), value: button.value },
  });
  const dispose = () => internals.safety.dispose().catch(() => {});
  return { received, click, dispose };
}

export function sortedKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
