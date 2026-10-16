import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue';

afterEach(() => {
  vi.useRealTimers();
});

describe('PendingQueue.snapshot', () => {
  it('reports blocked scopes and waiting counts while a flush is held', () => {
    vi.useFakeTimers();
    const queue = new PendingQueue(600, () => {});
    queue.push('oc_scope', msg('om_a'));
    queue.block('oc_scope');
    queue.push('oc_scope', msg('om_b'));
    expect(queue.isBlocked('oc_scope')).toBe(true);
    expect(queue.waitingCount('oc_scope')).toBe(2);
    expect(queue.snapshot()).toEqual({
      blocked: ['oc_scope'],
      waiting: [{ scope: 'oc_scope', count: 2 }],
    });
  });
});

describe('PendingQueue.cancelAll', () => {
  it('returns unflushed messages so a disconnect can unrecord them', () => {
    vi.useFakeTimers();
    const flushed: NormalizedMessage[][] = [];
    const queue = new PendingQueue(600, (_scope, batch) => {
      flushed.push(batch);
    });
    queue.push('oc_scope', msg('om_a'));
    queue.block('oc_scope');
    queue.push('oc_scope', msg('om_b'));
    const dropped = queue.cancelAll();
    expect(dropped.map((item) => item.messageId)).toEqual(['om_a', 'om_b']);
    vi.advanceTimersByTime(600);
    expect(flushed).toEqual([]);
  });
});

function msg(messageId: string): NormalizedMessage {
  return {
    messageId,
    content: messageId,
    chatId: 'oc_scope',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    mentionedBot: true,
    rawContentType: 'text',
    resources: [],
    createTime: 1_760_000_000_000,
  } as unknown as NormalizedMessage;
}
