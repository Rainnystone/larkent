import { FEISHU_UUID_WINDOW_MS } from '../../src/bot/feishu-delivery';
import { assertCardSchema2 } from './card-schema2';

export interface FakeChannelMessage {
  chatId: string;
  content: unknown;
  options: unknown;
}

export interface FakeChannelStream {
  chatId: string;
  input: unknown;
  options: unknown;
  messageId: string;
  cardUpdates: unknown[];
  markdownContents: string[];
}

export interface FakeRawClientRequest {
  method: string;
  params: unknown;
}

export interface FakePin {
  messageId: string;
  chatId: string;
}

export interface FakeChannelOptions {
  botAppId?: string;
  now?: () => number;
}

export interface FakeChannel {
  readonly sent: FakeChannelMessage[];
  readonly streams: FakeChannelStream[];
  /**
   * Maps a messageId to the `thread_id` that `fetchRawMessage` should report
   * for it — mirrors the raw `im.v1.message.get` items[0].thread_id that the
   * card dispatcher reads to scope topic-group clicks. Empty by default.
   */
  readonly rawThreadIds: Map<string, string>;
  fetchRawMessage(messageId: string): Promise<Array<{ thread_id?: string }>>;
  readonly rawClient: {
    readonly requests: FakeRawClientRequest[];
    request(method: string, params: unknown): Promise<unknown>;
    readonly cardkit: {
      readonly v1: {
        readonly card: {
          create(params: unknown): Promise<unknown>;
          update(params: unknown): Promise<unknown>;
        };
      };
    };
    readonly im: {
      readonly v1: {
        readonly message: {
          create(params: unknown): Promise<unknown>;
          reply(params: unknown): Promise<unknown>;
          delete(params: unknown): Promise<unknown>;
          list(params: unknown): Promise<unknown>;
        };
        readonly pin: {
          create(params: unknown): Promise<unknown>;
          list(params: unknown): Promise<unknown>;
          delete(params: unknown): Promise<unknown>;
        };
      };
    };
  };
  createCard(cardJson: unknown): Promise<{ cardId: string }>;
  updateCardById(cardId: string, cardJson: unknown, sequence: number): Promise<void>;
  updateCard(messageId: string, cardJson: unknown): Promise<void>;
  readonly updatedCards: Array<{ messageId: string; card: unknown }>;
  readonly pins: FakePin[];
  readonly cardErrors: { update?: unknown; create?: unknown };
  readonly sendErrors: { send?: unknown };
  dropPins(): void;
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
  /**
   * SDK-faithful stream faults: `update`/`setContent` always resolve.
   * `open` rejects before a message exists; `finish` rejects after create
   * (the `stream()` result is the delivery signal). `hangFinish` never
   * settles `stream()` after the producer returns (TCP accepted, no response).
   */
  readonly streamErrors: { open?: unknown; finish?: unknown; hangFinish?: boolean };
  getConnectionStatus(): { state: 'connected' | 'reconnecting' | 'failed'; reconnectAttempts: number };
  getAppInfo(): Promise<{ ownerId: string }>;
}

interface StoredChatMessage {
  messageId: string;
  chatId: string;
  content: unknown;
  options: unknown;
  uuid?: string;
  createTime: number;
  parentId?: string;
  threadId?: string;
  inThread?: boolean;
  msgType: string;
}

export function createFakeChannel(options: FakeChannelOptions = {}): FakeChannel {
  const botAppId = options.botAppId ?? 'cli_bot';
  const now = options.now ?? Date.now;
  const sent: FakeChannelMessage[] = [];
  const streams: FakeChannelStream[] = [];
  const requests: FakeRawClientRequest[] = [];
  const updatedCards: Array<{ messageId: string; card: unknown }> = [];
  const rawThreadIds = new Map<string, string>();
  const cardById = new Map<string, unknown>();
  const messageByCard = new Map<string, string>();
  const byUuid = new Map<string, StoredChatMessage>();
  const byId = new Map<string, StoredChatMessage>();
  const chat: StoredChatMessage[] = [];
  const pins: FakePin[] = [];
  let nextCard = 1;
  let nextMessage = 1;

  const streamErrors: { open?: unknown; finish?: unknown; hangFinish?: boolean } = {};
  const cardErrors: { update?: unknown; create?: unknown } = {};
  const sendErrors: { send?: unknown } = {};

  const throwCardUpdateIfArmed = (): void => {
    if (cardErrors.update === undefined) return;
    const err = cardErrors.update;
    cardErrors.update = undefined;
    throw err;
  };

  const applyCardToMessage = (messageId: string, cardJson: unknown): void => {
    updatedCards.push({ messageId, card: cardJson });
    const stored = byId.get(messageId);
    if (stored) stored.content = { card: cardJson };
  };
  const land = (input: {
    chatId: string;
    content: unknown;
    options: unknown;
    uuid?: string;
    parentId?: string;
    msgType: string;
    trackSent?: boolean;
  }): { message_id: string; body: { content: string } } => {
    const echo = stringifyContent(input.content);
    if (input.uuid) {
      const original = byUuid.get(input.uuid);
      if (original && now() - original.createTime <= FEISHU_UUID_WINDOW_MS) {
        return { message_id: original.messageId, body: { content: echo } };
      }
      if (original) byUuid.delete(input.uuid);
    }
    const inThread = outboundReplyInThread(input.options);
    const threadId = inThread ? rawThreadIds.get(input.parentId ?? '') : undefined;
    const messageId = `om_fake_${nextMessage++}`;
    const stored: StoredChatMessage = {
      messageId,
      chatId: input.chatId,
      content: input.content,
      options: input.options,
      createTime: now(),
      msgType: input.msgType,
      ...(input.uuid ? { uuid: input.uuid } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(threadId ? { threadId, inThread: true } : {}),
    };
    chat.push(stored);
    byId.set(messageId, stored);
    if (input.uuid) byUuid.set(input.uuid, stored);
    if (input.trackSent !== false) {
      sent.push({ chatId: input.chatId, content: input.content, options: input.options });
    }
    return { message_id: messageId, body: { content: stringifyContent(input.content) } };
  };

  const pushManagedCardMessage = (params: unknown, fallbackChatId: string, method: string): {
    message_id: string;
    body: { content: string };
  } => {
    requests.push({ method, params });
    const card = resolveReferencedCard(params);
    const data = nestedData(params);
    const content = card ? { card } : parseJsonContent(data?.content) ?? params;
    return land({
      chatId: extractReceiveId(params) ?? fallbackChatId,
      content,
      options: undefined,
      uuid: stringField(data, 'uuid'),
      parentId: replyParentId(params),
      msgType: stringField(data, 'msg_type') ?? (card ? 'interactive' : 'text'),
    });
  };

  return {
    sent,
    streams,
    streamErrors,
    cardErrors,
    sendErrors,
    updatedCards,
    pins,
    dropPins() {
      pins.splice(0);
    },
    rawThreadIds,
    async fetchRawMessage(messageId: string): Promise<Array<{ thread_id?: string }>> {
      const threadId = rawThreadIds.get(messageId);
      return [threadId ? { thread_id: threadId } : {}];
    },
    rawClient: {
      requests,
      async request(method: string, params: unknown): Promise<unknown> {
        requests.push({ method, params });
        return undefined;
      },
      cardkit: {
        v1: {
          card: {
            async create(params: unknown): Promise<unknown> {
              requests.push({ method: 'cardkit.v1.card.create', params });
              const cardId = `card_fake_${nextCard++}`;
              cardById.set(cardId, extractCardJson(params));
              return { data: { card_id: cardId } };
            },
            async update(params: unknown): Promise<unknown> {
              requests.push({ method: 'cardkit.v1.card.update', params });
              return {};
            },
          },
        },
      },
      im: {
        v1: {
          message: {
            async create(params: unknown): Promise<unknown> {
              return { data: pushManagedCardMessage(params, '', 'im.v1.message.create') };
            },
            async reply(params: unknown): Promise<unknown> {
              return { data: pushManagedCardMessage(params, '', 'im.v1.message.reply') };
            },
            async delete(params: unknown): Promise<unknown> {
              requests.push({ method: 'im.v1.message.delete', params });
              return {};
            },
            async list(params: unknown): Promise<unknown> {
              requests.push({ method: 'im.v1.message.list', params });
              return listMessages(params);
            },
          },
          pin: {
            async create(params: unknown): Promise<unknown> {
              requests.push({ method: 'im.v1.pin.create', params });
              const messageId = stringField(nestedData(params), 'message_id') ?? '';
              const stored = byId.get(messageId);
              const chatId = stored?.chatId ?? '';
              if (!pins.some((pin) => pin.messageId === messageId)) {
                pins.push({ messageId, chatId });
              }
              return { data: { pin: { message_id: messageId, chat_id: chatId } } };
            },
            async list(params: unknown): Promise<unknown> {
              requests.push({ method: 'im.v1.pin.list', params });
              const nested = asRecord(asRecord(params)?.params) ?? asRecord(params) ?? {};
              const chatId = typeof nested.chat_id === 'string' ? nested.chat_id : '';
              return {
                data: {
                  items: pins
                    .filter((pin) => !chatId || pin.chatId === chatId)
                    .map((pin) => ({ message_id: pin.messageId, chat_id: pin.chatId })),
                  has_more: false,
                },
              };
            },
            async delete(params: unknown): Promise<unknown> {
              requests.push({ method: 'im.v1.pin.delete', params });
              const path = asRecord(asRecord(params)?.path) ?? {};
              const messageId = typeof path.message_id === 'string' ? path.message_id : '';
              const index = pins.findIndex((pin) => pin.messageId === messageId);
              if (index >= 0) pins.splice(index, 1);
              return { data: {} };
            },
          },
        },
      },
    },
    async createCard(cardJson: unknown): Promise<{ cardId: string }> {
      if (cardErrors.create !== undefined) {
        const err = cardErrors.create;
        cardErrors.create = undefined;
        throw err;
      }
      assertCardSchema2(cardJson);
      const cardId = `card_fake_${nextCard++}`;
      cardById.set(cardId, cardJson);
      return { cardId };
    },
    async updateCardById(cardId: string, cardJson: unknown, sequence: number): Promise<void> {
      throwCardUpdateIfArmed();
      assertCardSchema2(cardJson);
      requests.push({ method: 'cardkit.v1.card.update', params: { cardId, cardJson, sequence } });
      cardById.set(cardId, cardJson);
      const messageId = messageByCard.get(cardId);
      if (messageId) applyCardToMessage(messageId, cardJson);
    },
    async updateCard(messageId: string, cardJson: unknown): Promise<void> {
      throwCardUpdateIfArmed();
      requests.push({ method: 'im.v1.message.patch', params: { messageId, cardJson } });
      applyCardToMessage(messageId, cardJson);
    },
    async send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }> {
      if (sendErrors.send !== undefined) {
        const err = sendErrors.send;
        sendErrors.send = undefined;
        throw err;
      }
      const cardId = (content as { cardId?: unknown } | undefined)?.cardId;
      const resolved =
        typeof cardId === 'string' && cardById.has(cardId)
          ? { card: cardById.get(cardId) }
          : content;
      const landed = land({
        chatId,
        content: resolved,
        options,
        uuid: outboundUuid(options),
        parentId: outboundReplyTo(options),
        msgType: inferMsgType(resolved),
      });
      if (typeof cardId === 'string') messageByCard.set(cardId, landed.message_id);
      return { messageId: landed.message_id };
    },
    getConnectionStatus() {
      return { state: 'connected' as const, reconnectAttempts: 0 };
    },
    async getAppInfo() {
      return { ownerId: 'ou_owner' };
    },
    async stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }> {
      const record: FakeChannelStream = {
        chatId,
        input,
        options,
        messageId: '',
        cardUpdates: [],
        markdownContents: [],
      };
      streams.push(record);

      const openErr = streamErrors.open;
      if (openErr !== undefined) {
        streamErrors.open = undefined;
        throw openErr;
      }

      const initial = isCardStreamInput(input)
        ? { card: input.card.initial }
        : { card: { schema: '2.0', body: { elements: [] } } };
      const landed = land({
        chatId,
        content: initial,
        options,
        uuid: outboundUuid(options),
        parentId: outboundReplyTo(options),
        msgType: 'interactive',
        trackSent: false,
      });
      record.messageId = landed.message_id;

      // Mirror @larksuite/channel 0.7.1: messageId is a class getter on the
      // prototype. Object spread in a wrapper drops it; tests must use this
      // shape so that class of bug fails instead of copying an own getter.
      const ctrl = new FakeStreamController(landed.message_id, record, byId);

      if (isCardStreamInput(input)) {
        await input.card.producer(ctrl);
      }
      if (isMarkdownStreamInput(input)) {
        await input.markdown(ctrl);
      }

      const finishErr = streamErrors.finish;
      if (finishErr !== undefined) {
        streamErrors.finish = undefined;
        throw finishErr;
      }
      if (streamErrors.hangFinish) {
        await new Promise(() => {});
      }
      return { messageId: landed.message_id };
    },
  };

  function listMessages(params: unknown): { data: { items: Record<string, unknown>[]; has_more: boolean; page_token?: string } } {
    const nested = asRecord(asRecord(params)?.params) ?? asRecord(params) ?? {};
    const containerType = nested.container_id_type === 'thread' ? 'thread' : 'chat';
    const containerId = typeof nested.container_id === 'string' ? nested.container_id : undefined;
    const sortDesc = nested.sort_type === 'ByCreateTimeDesc';
    const startMs = boundTimeMs(nested.start_time);
    const endMs = boundTimeMs(nested.end_time);
    const pageSize = parsePageSize(nested.page_size);
    const offset = parsePageOffset(nested.page_token);

    let items = chat.filter((item) => {
      if (containerType === 'thread') {
        return item.inThread === true && Boolean(containerId) && item.threadId === containerId;
      }
      if (item.inThread) return false;
      return !containerId || item.chatId === containerId;
    });
    if (startMs !== undefined) items = items.filter((item) => item.createTime >= startMs);
    if (endMs !== undefined) items = items.filter((item) => item.createTime <= endMs);
    items = [...items].sort((a, b) => (
      sortDesc ? b.createTime - a.createTime : a.createTime - b.createTime
    ));
    const sliced = pageSize === undefined ? items.slice(offset) : items.slice(offset, offset + pageSize);
    const nextOffset = offset + sliced.length;
    const hasMore = nextOffset < items.length;
    return {
      data: {
        items: sliced.map((item) => listItem(item, botAppId)),
        has_more: hasMore,
        ...(hasMore ? { page_token: String(nextOffset) } : {}),
      },
    };
  }

  function resolveReferencedCard(params: unknown): unknown | undefined {
    const content = (params as { data?: { content?: unknown } } | undefined)?.data?.content;
    if (typeof content !== 'string') return undefined;
    try {
      const parsed = JSON.parse(content) as { data?: { card_id?: string } };
      return parsed.data?.card_id ? cardById.get(parsed.data.card_id) : undefined;
    } catch {
      return undefined;
    }
  }
}

function extractCardJson(params: unknown): unknown {
  const data = (params as { data?: { data?: unknown } } | undefined)?.data?.data;
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

function extractReceiveId(params: unknown): string | undefined {
  const receiveId = (params as { data?: { receive_id?: unknown } } | undefined)?.data?.receive_id;
  return typeof receiveId === 'string' ? receiveId : undefined;
}

function nestedData(params: unknown): Record<string, unknown> | undefined {
  const rec = asRecord(params);
  const data = rec?.data;
  return asRecord(data);
}

function replyParentId(params: unknown): string | undefined {
  const rec = asRecord(params);
  const path = asRecord(rec?.path);
  const fromPath = path?.message_id;
  return typeof fromPath === 'string' ? fromPath : undefined;
}

function extractContainerId(params: unknown): string | undefined {
  const rec = asRecord(params);
  const nested = asRecord(rec?.params) ?? rec;
  const id = nested?.container_id;
  return typeof id === 'string' ? id : undefined;
}

function listItem(item: StoredChatMessage, botAppId: string): Record<string, unknown> {
  return {
    message_id: item.messageId,
    ...(item.parentId ? { parent_id: item.parentId } : {}),
    ...(item.threadId ? { thread_id: item.threadId } : {}),
    create_time: String(item.createTime),
    msg_type: item.msgType,
    sender: { id: botAppId, id_type: 'app_id', sender_type: 'app' },
    body: { content: stringifyContent(item.content) },
  };
}

function outboundUuid(options: unknown): string | undefined {
  return stringField(asRecord(options), 'uuid');
}

function outboundReplyTo(options: unknown): string | undefined {
  return stringField(asRecord(options), 'replyTo');
}

function outboundReplyInThread(options: unknown): boolean {
  return asRecord(options)?.replyInThread === true;
}

function boundTimeMs(raw: unknown): number | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function parsePageSize(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(50, Math.floor(n));
}

function parsePageOffset(raw: unknown): number {
  if (typeof raw !== 'string' || !raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function inferMsgType(content: unknown): string {
  if (asRecord(content)?.card !== undefined) return 'interactive';
  if (asRecord(content)?.markdown !== undefined) return 'post';
  return 'text';
}

function stringifyContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function parseJsonContent(content: unknown): unknown | undefined {
  if (typeof content !== 'string') return undefined;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/**
 * SDK-faithful stream controller: `messageId` is a prototype getter, matching
 * `@larksuite/channel` 0.7.1 card (:3938) and markdown (:4124) controllers.
 */
class FakeStreamController {
  constructor(
    private readonly landedId: string,
    private readonly record: FakeChannelStream,
    private readonly store: Map<string, StoredChatMessage>,
  ) {}

  get messageId(): string {
    return this.landedId;
  }

  async update(card: unknown): Promise<void> {
    this.record.cardUpdates.push(card);
    const stored = this.store.get(this.landedId);
    if (stored) stored.content = { card };
  }

  async setContent(markdown: string): Promise<void> {
    this.record.markdownContents.push(markdown);
    const stored = this.store.get(this.landedId);
    if (stored) {
      stored.content = {
        card: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: markdown }] } },
      };
    }
  }
}

interface FakeCardController {
  readonly messageId: string;
  update(card: unknown): Promise<void>;
}

interface FakeMarkdownController {
  readonly messageId: string;
  setContent(markdown: string): Promise<void>;
}

interface FakeCardStreamInput {
  card: {
    initial: unknown;
    producer(ctrl: FakeCardController): Promise<void> | void;
  };
}

interface FakeMarkdownStreamInput {
  markdown(ctrl: FakeMarkdownController): Promise<void> | void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCardStreamInput(value: unknown): value is FakeCardStreamInput {
  if (!isRecord(value) || !isRecord(value.card)) return false;
  return typeof value.card.producer === 'function';
}

function isMarkdownStreamInput(value: unknown): value is FakeMarkdownStreamInput {
  return isRecord(value) && typeof value.markdown === 'function';
}
