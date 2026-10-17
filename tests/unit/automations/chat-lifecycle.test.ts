import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_CHAT_LIFECYCLE_EVENTS,
  abandonIfNotInChat,
  attachAutomationChatLifecycle,
  chatIdFromRawEvent,
} from '../../../src/automations/chat-lifecycle';
import { axiosLike, sdkShapedSendError } from '../../helpers/sdk-feishu-errors';

describe('automation chat lifecycle', () => {
  it('registers bot-deleted and disbanded through onRawEvent', () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const channel = {
      onRawEvent(eventType: string, handler: (data: unknown) => void) {
        handlers.set(eventType, handler);
        return () => handlers.delete(eventType);
      },
    };
    const onRemoved = vi.fn();
    const detach = attachAutomationChatLifecycle(channel, onRemoved);

    expect([...handlers.keys()].sort()).toEqual([
      AUTO_CHAT_LIFECYCLE_EVENTS.disbanded,
      AUTO_CHAT_LIFECYCLE_EVENTS.botDeleted,
    ].sort());

    handlers.get(AUTO_CHAT_LIFECYCLE_EVENTS.botDeleted)?.({ chat_id: 'oc_a' });
    handlers.get(AUTO_CHAT_LIFECYCLE_EVENTS.disbanded)?.({ event: { chat_id: 'oc_b' } });
    expect(onRemoved.mock.calls).toEqual([['oc_a'], ['oc_b']]);

    detach();
    expect(handlers.size).toBe(0);
  });

  it('degrades when onRawEvent is missing', () => {
    const onRemoved = vi.fn();
    const detach = attachAutomationChatLifecycle({}, onRemoved);
    detach();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it('reads chat_id from the event body or a nested event wrapper', () => {
    expect(chatIdFromRawEvent({ chat_id: 'oc_direct' })).toBe('oc_direct');
    expect(chatIdFromRawEvent({ event: { chat_id: 'oc_nested' } })).toBe('oc_nested');
    expect(chatIdFromRawEvent({})).toBeUndefined();
  });

  it('abandons a chat only for not-in-chat send errors', async () => {
    const remove = vi.fn(async () => true);
    const leave = sdkShapedSendError('format_error', axiosLike('outside', {
      response: { status: 400, data: { code: 230002 } },
    }));
    const gone = sdkShapedSendError('unknown', axiosLike('not found', {
      response: { status: 404 },
    }));
    expect(await abandonIfNotInChat(leave, 'oc_a', remove)).toBe(true);
    expect(remove).toHaveBeenCalledWith('oc_a');
    expect(await abandonIfNotInChat(gone, 'oc_a', remove)).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
