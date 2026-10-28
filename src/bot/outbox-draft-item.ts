import type { OutboxItemState } from './turn-journal';

/** A cardId without a receipt is an unknown send, never permission to send again, unless sendAttempted is false. */
export interface DraftCardItem {
  kind: 'draft-card';
  deliveryId: string;
  state: OutboxItemState;
  createdAt: number;
  target: { chatId: string; replyTo?: string; replyInThread?: boolean; threadId?: string };
  payload: { draftId: string; card: object };
  cardId?: string;
  /**
   * false: cardId committed and channel.send never started, so recovery sends.
   * true: committed immediately before channel.send, so recovery only reads back.
   * Absent with a cardId: written before this field existed. Migrated v2 `sending`
   * items committed cardId right before sending; earlier journal items may have
   * stopped before send. Neither can be told from a landed send, so absent is
   * treated as attempted: an unsent card stays unknown rather than risk a duplicate.
   */
  sendAttempted?: boolean;
  receipt?: { messageId: string; cardId?: string };
  rejection?: { message: string; code?: number };
}

export function parseDraftCardItem(raw: unknown, id: string): DraftCardItem {
  if (!isObject(raw) || raw.kind !== 'draft-card' || raw.deliveryId !== id || !id
    || typeof raw.state !== 'string' || !['staged', 'sent', 'rejected', 'voided'].includes(raw.state)
    || typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)
    || !isObject(raw.target) || typeof raw.target.chatId !== 'string' || !raw.target.chatId
    || !isObject(raw.payload) || typeof raw.payload.draftId !== 'string' || !raw.payload.draftId || !isObject(raw.payload.card)
    || (raw.cardId !== undefined && (typeof raw.cardId !== 'string' || !raw.cardId))
    || (raw.sendAttempted !== undefined && (typeof raw.sendAttempted !== 'boolean' || raw.cardId === undefined))
    || (raw.receipt !== undefined && (!isObject(raw.receipt) || typeof raw.receipt.messageId !== 'string' || !raw.receipt.messageId
      || raw.receipt.cardId !== raw.cardId))
    || (raw.state === 'sent' && !raw.receipt)
    || (raw.target.replyInThread === true && (typeof raw.target.threadId !== 'string' || !raw.target.threadId))) {
    throw new Error('Invalid draft-card Outbox item');
  }
  return structuredClone(raw) as unknown as DraftCardItem;
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}
