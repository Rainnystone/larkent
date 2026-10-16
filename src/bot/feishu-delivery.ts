import { replyDeliveryKey, type TurnJournalEntry, type TurnReply } from './turn-journal';
import { classify, isGoneMessage } from './feishu-error';

export const FEISHU_UUID_WINDOW_MS = 60 * 60 * 1000;
export const FEISHU_LIST_VISIBILITY_LAG_MS = 2_000;
export const FEISHU_READBACK_PAGE_SIZE = 50;
export const FEISHU_READBACK_MAX_PAGES = 20;

export type DeliverySendOptions = {
  replyTo?: string;
  replyInThread?: boolean;
  uuid?: string;
};

export type DeliveryChannel = {
  send(
    chatId: string,
    content: { markdown: string } | { card: object } | { text: string },
    options?: DeliverySendOptions,
  ): Promise<{ messageId?: string }>;
  updateCard(messageId: string, card: unknown): Promise<void>;
  rawClient: {
    im: {
      v1: {
        message: {
          list(params: unknown): Promise<unknown>;
        };
      };
    };
  };
};

export type ReadBackMatch =
  | { kind: 'none' }
  | { kind: 'card'; messageId: string }
  | { kind: 'text'; messageId: string };

export function recoveryAnswerCard(markdown: string): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements: [{ tag: 'markdown', content: markdown }] },
  };
}

export function withDeliveryUuid<T extends object>(
  opts: T,
  deliveryId?: string,
): T & { uuid?: string } {
  if (!deliveryId) return opts;
  return { ...opts, uuid: deliveryId };
}

export async function redeliverStagedReply(input: {
  channel: DeliveryChannel;
  entry: TurnJournalEntry;
  botAppId: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ delivered: boolean; messageId?: string }> {
  const reply = input.entry.reply;
  if (!reply?.markdown.trim()) return { delivered: false };
  if (input.entry.cliAlreadySent) {
    return { delivered: true, ...(reply.messageId ? { messageId: reply.messageId } : {}) };
  }
  if (reply.messageId && isInteractiveReceipt(reply)) {
    try {
      await patchSameCard(input.channel, reply.messageId, reply.markdown);
      return { delivered: true, messageId: reply.messageId };
    } catch (err) {
      const kind = classify(err);
      switch (kind) {
        case 'link':
          throw err;
        case 'rejected':
          if (!isGoneMessage(err)) throw err;
          break;
        case 'local':
          throw err;
        default: {
          const _exhaustive: never = kind;
          throw _exhaustive;
        }
      }
    }
  } else if (reply.messageId) {
    return { delivered: true, messageId: reply.messageId };
  }

  const now = input.now ?? Date.now;
  const outsideUuidWindow = now() - input.entry.createdAt > FEISHU_UUID_WINDOW_MS;
  if (outsideUuidWindow) {
    await (input.sleep ?? defaultSleep)(FEISHU_LIST_VISIBILITY_LAG_MS);
    const found = await readBackBotReply({
      channel: input.channel,
      chatId: input.entry.chatId,
      parentId: reply.replyTo,
      botAppId: input.botAppId,
      afterMs: input.entry.createdAt,
      receiptId: reply.messageId,
    });
    switch (found.kind) {
      case 'none':
        break;
      case 'card':
        await patchSameCard(input.channel, found.messageId, reply.markdown);
        return { delivered: true, messageId: found.messageId };
      case 'text':
        return { delivered: true, messageId: found.messageId };
      default: {
        const _exhaustive: never = found;
        return _exhaustive;
      }
    }
  }

  const result = await input.channel.send(
    input.entry.chatId,
    { markdown: reply.markdown },
    withDeliveryUuid({
      replyTo: reply.replyTo,
      ...(reply.replyInThread ? { replyInThread: true } : {}),
    }, reply.deliveryId?.trim() || replyDeliveryKey(input.entry.turnId)),
  );
  const messageId = result.messageId?.trim();
  if (!messageId) throw new Error('final journal-resend reply missing message receipt');
  return { delivered: true, messageId };
}

export async function readBackBotReply(input: {
  channel: DeliveryChannel;
  chatId: string;
  parentId: string;
  botAppId: string;
  afterMs: number;
  receiptId?: string;
}): Promise<ReadBackMatch> {
  let pageToken: string | undefined;
  for (let page = 0; page < FEISHU_READBACK_MAX_PAGES; page += 1) {
    const res = await input.channel.rawClient.im.v1.message.list({
      params: {
        container_id_type: 'chat',
        container_id: input.chatId,
        start_time: String(Math.floor(input.afterMs / 1000)),
        sort_type: 'ByCreateTimeDesc',
        page_size: FEISHU_READBACK_PAGE_SIZE,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    const payload = asRecord(asRecord(res)?.data);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    for (const raw of items) {
      const match = matchListedReply(raw, input);
      if (match.kind !== 'none') return match;
    }
    const more = payload?.has_more === true && typeof payload.page_token === 'string';
    if (!more) break;
    pageToken = payload.page_token as string;
  }
  return { kind: 'none' };
}

async function patchSameCard(
  channel: DeliveryChannel,
  messageId: string,
  markdown: string,
): Promise<void> {
  await channel.updateCard(messageId, recoveryAnswerCard(markdown));
}

function matchListedReply(
  raw: unknown,
  input: {
    parentId: string;
    botAppId: string;
    afterMs: number;
    receiptId?: string;
  },
): ReadBackMatch {
  const item = asRecord(raw);
  if (!item) return { kind: 'none' };
  const messageId = typeof item.message_id === 'string' ? item.message_id : undefined;
  if (!messageId) return { kind: 'none' };
  if (input.receiptId && messageId === input.receiptId) {
    return listedKind(item, messageId);
  }
  const parentId = typeof item.parent_id === 'string' ? item.parent_id : undefined;
  if (parentId !== input.parentId) return { kind: 'none' };
  const sender = asRecord(item.sender);
  if (typeof sender?.id !== 'string' || sender.id !== input.botAppId) return { kind: 'none' };
  if (createTimeMs(item.create_time) < input.afterMs) return { kind: 'none' };
  return listedKind(item, messageId);
}

function listedKind(item: Record<string, unknown>, messageId: string): ReadBackMatch {
  const msgType = typeof item.msg_type === 'string' ? item.msg_type : '';
  if (msgType === 'interactive' || msgType === 'card') return { kind: 'card', messageId };
  const body = asRecord(item.body);
  const content = typeof body?.content === 'string' ? body.content : '';
  if (content.includes('"card"') || content.includes('"schema":"2.0"')) {
    return { kind: 'card', messageId };
  }
  return { kind: 'text', messageId };
}

function isInteractiveReceipt(reply: TurnReply): boolean {
  return reply.replyMode === 'card' || reply.interactive === true;
}

function createTimeMs(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  return n < 1e12 ? n * 1000 : n;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
