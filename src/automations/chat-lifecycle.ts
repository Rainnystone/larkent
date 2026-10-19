import { isNotInChat } from '../bot/feishu-error';
import { log } from '../core/logger';

/** Feishu events that mean this bot left the chat or the chat is gone. */
export const AUTO_CHAT_LIFECYCLE_EVENTS = {
  botDeleted: 'im.chat.member.bot.deleted_v1',
  disbanded: 'im.chat.disbanded_v1',
} as const;

/**
 * The slice of `LarkChannel` we subscribe through: `onRawEvent`, public since
 * `@larksuite/channel` 0.5.0. Structural so tests can fake it without the SDK class.
 */
interface RawEventSource {
  onRawEvent(
    eventType: string,
    handler: (payload: unknown) => void | Promise<void>,
  ): () => void;
}

export async function abandonIfNotInChat(
  error: unknown,
  chatId: string,
  remove?: (id: string) => void | Promise<unknown>,
): Promise<boolean> {
  if (!remove || !isNotInChat(error)) return false;
  await remove(chatId);
  return true;
}

export function chatIdFromRawEvent(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  if (typeof data.chat_id === 'string' && data.chat_id) return data.chat_id;
  const event = data.event;
  if (isRecord(event) && typeof event.chat_id === 'string' && event.chat_id) return event.chat_id;
  return undefined;
}

/**
 * Subscribe `im.chat.member.bot.deleted_v1` and `im.chat.disbanded_v1` on the
 * existing long connection. Same public `onRawEvent` path as meeting push.
 */
export function attachAutomationChatLifecycle(
  channel: unknown,
  onRemoved: (chatId: string) => void | Promise<unknown>,
): () => void {
  const source = channel as RawEventSource | undefined;
  if (typeof source?.onRawEvent !== 'function') {
    log.warn('auto', 'chat-lifecycle-unavailable', {
      reason: 'channel 不支持 onRawEvent（需要 @larksuite/channel >= 0.5.0）',
    });
    return () => {};
  }
  const unsubscribers: Array<() => void> = [];
  try {
    for (const eventType of Object.values(AUTO_CHAT_LIFECYCLE_EVENTS)) {
      unsubscribers.push(
        source.onRawEvent(eventType, (data) => {
          const chatId = chatIdFromRawEvent(data);
          if (!chatId) return;
          void Promise.resolve(onRemoved(chatId)).catch((error) => {
            log.fail('auto', error, { event: 'removed-from-chat', chatId });
          });
        }),
      );
    }
  } catch (error) {
    for (const off of unsubscribers.splice(0)) {
      try { off(); } catch { /* channel already gone */ }
    }
    log.warn('auto', 'chat-lifecycle-failed', {
      err: error instanceof Error ? error.message : String(error),
    });
    return () => {};
  }
  return () => {
    for (const off of unsubscribers.splice(0)) {
      try { off(); } catch { /* channel already gone */ }
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
