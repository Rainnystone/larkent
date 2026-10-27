import type {
  TurnJournalEntry,
  TurnReply,
  TurnNotice,
  OutboxItemState,
} from './turn-journal';

export type StageReply = Omit<TurnReply, 'replyMode'> & { replyMode?: string };
type Change = Partial<TurnJournalEntry>;

export function stageReply(entry: TurnJournalEntry, reply: StageReply): Change {
  const threadId = reply.threadId?.trim() || entry.threadId;
  const next: TurnReply = {
    markdown: reply.markdown,
    replyTo: reply.replyTo,
    replyMode: reply.replyMode ?? 'text',
    ...(reply.replyInThread ? { replyInThread: true } : {}),
    ...(threadId ? { threadId } : {}),
    deliveryId: reply.deliveryId ?? replyDeliveryKey(entry.turnId),
    ...(reply.messageId ? { messageId: reply.messageId } : {}),
    ...(reply.interactive ? { interactive: true } : {}),
    ...(reply.supersedes?.trim()
      ? { supersedes: reply.supersedes.trim() }
      : {}),
    state: 'staged',
  };
  return {
    status:
      noticeState(entry) === 'staged'
        ? 'notice-pending'
        : 'completed-undelivered',
    reply: next,
  };
}

export function replyDelivered(entry: TurnJournalEntry): Change {
  const state = replyState(entry);
  if (state === 'rejected' || state === 'voided') return {};
  return {
    ...(entry.reply ? { reply: { ...entry.reply, state: 'sent' } } : {}),
    status:
      noticeState(entry) === 'staged' ? 'notice-pending' : 'reply-delivered',
  };
}

export function replyRejected(entry: TurnJournalEntry): Change {
  if (!entry.reply) return {};
  return {
    reply: { ...entry.reply, state: 'rejected' },
    status:
      noticeState(entry) === 'staged' ? 'notice-pending' : 'reply-delivered',
  };
}

export function noteReplyReceipt(
  entry: TurnJournalEntry,
  messageId: string,
  interactive?: boolean,
): Change {
  if (!entry.reply || !messageId.trim()) return {};
  const { interactive: previous, ...reply } = entry.reply;
  const keep =
    interactive === true || (interactive !== false && previous === true);
  return {
    reply: { ...reply, messageId, ...(keep ? { interactive: true } : {}) },
  };
}

export function stageNotice(
  entry: TurnJournalEntry,
  notice: TurnNotice,
): Change {
  return {
    status: 'notice-pending',
    noticeStatus: 'pending',
    notice: {
      ...notice,
      deliveryId: notice.deliveryId ?? noticeDeliveryKey(entry.turnId),
      state: notice.state ?? 'staged',
    },
  };
}

export function noticeRejected(entry: TurnJournalEntry): Change {
  if (!entry.notice) return {};
  return {
    notice: { ...entry.notice, state: 'rejected' },
    status:
      replyState(entry) === 'staged'
        ? 'completed-undelivered'
        : 'notice-delivered',
  };
}

export function noticeDelivered(entry: TurnJournalEntry): Change {
  return {
    ...(entry.notice ? { notice: { ...entry.notice, state: 'sent' } } : {}),
    noticeStatus: 'delivered',
    status:
      replyState(entry) === 'staged'
        ? 'completed-undelivered'
        : 'notice-delivered',
  };
}

export function voidItems(entry: TurnJournalEntry): Change {
  return {
    ...(entry.reply ? { reply: { ...entry.reply, state: 'voided' } } : {}),
    ...voidNotice(entry),
  };
}

export function voidNotice(entry: TurnJournalEntry): Change {
  return entry.notice ? { notice: { ...entry.notice, state: 'voided' } } : {};
}

export function replyState(
  entry: TurnJournalEntry,
): OutboxItemState | undefined {
  if (!entry.reply) return undefined;
  if (entry.status === 'voided') return 'voided';
  if (entry.reply.state) return entry.reply.state;
  switch (entry.status) {
    case 'reply-delivered':
      return 'sent';
    case 'completed-undelivered':
    case 'settled':
    case 'notice-pending':
    case 'queued':
    case 'running':
    case 'interrupted':
      return 'staged';
    case 'notice-delivered':
      return entry.reply.messageId ? 'sent' : 'staged';
    default: {
      const _exhaustive: never = entry.status;
      return _exhaustive;
    }
  }
}

export function noticeState(
  entry: TurnJournalEntry,
): OutboxItemState | undefined {
  if (!entry.notice) return undefined;
  if (entry.noticeInvalidated || entry.status === 'voided') return 'voided';
  if (entry.notice.state) return entry.notice.state;
  switch (entry.status) {
    case 'notice-pending':
      return 'staged';
    case 'notice-delivered':
      return 'sent';
    case 'queued':
    case 'running':
    case 'settled':
    case 'reply-delivered':
    case 'completed-undelivered':
    case 'interrupted':
      if (entry.noticeStatus === 'pending') return 'staged';
      if (entry.noticeStatus === 'delivered' || entry.notice.messageId)
        return 'sent';
      return 'staged';
    default: {
      const _exhaustive: never = entry.status;
      return _exhaustive;
    }
  }
}

export const FEISHU_DELIVERY_ID_MAX_CHARS = 50;

export function replyDeliveryKey(turnId: string): string {
  return clipDeliveryId(`reply:${turnId}`);
}

export function noticeDeliveryKey(turnId: string): string {
  return clipDeliveryId(`notice:${turnId}`);
}

export function noticeOwnerDeliveryKey(turnId: string): string {
  return clipDeliveryId(`notice-owner:${turnId}`);
}

export function streamDeliveryKey(turnId: string): string {
  return clipDeliveryId(`stream:${turnId}`);
}

function clipDeliveryId(id: string): string {
  return id.length <= FEISHU_DELIVERY_ID_MAX_CHARS
    ? id
    : id.slice(0, FEISHU_DELIVERY_ID_MAX_CHARS);
}
