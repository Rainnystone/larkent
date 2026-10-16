export interface FakeChannelMessage {
  chatId: string;
  content: unknown;
  options: unknown;
}

export interface FakeChannelStream {
  chatId: string;
  input: unknown;
  options: unknown;
  cardUpdates: unknown[];
  markdownContents: string[];
}

export interface FakeRawClientRequest {
  method: string;
  params: unknown;
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
      };
    };
  };
  createCard(cardJson: unknown): Promise<{ cardId: string }>;
  updateCardById(cardId: string, cardJson: unknown, sequence: number): Promise<void>;
  updateCard(messageId: string, cardJson: unknown): Promise<void>;
  readonly updatedCards: Array<{ messageId: string; card: unknown }>;
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
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
  const byUuid = new Map<string, StoredChatMessage>();
  const byId = new Map<string, StoredChatMessage>();
  const chat: StoredChatMessage[] = [];
  let nextCard = 1;
  let nextMessage = 1;

  const land = (input: {
    chatId: string;
    content: unknown;
    options: unknown;
    uuid?: string;
    parentId?: string;
    msgType: string;
  }): { message_id: string; body: { content: string } } => {
    const echo = stringifyContent(input.content);
    if (input.uuid) {
      const original = byUuid.get(input.uuid);
      if (original) {
        return { message_id: original.messageId, body: { content: echo } };
      }
    }
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
    };
    chat.push(stored);
    byId.set(messageId, stored);
    if (input.uuid) byUuid.set(input.uuid, stored);
    sent.push({ chatId: input.chatId, content: input.content, options: input.options });
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
    updatedCards,
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
              const containerId = extractContainerId(params);
              const items = chat
                .filter((item) => !containerId || item.chatId === containerId)
                .map((item) => listItem(item, botAppId));
              return { data: { items, has_more: false } };
            },
          },
        },
      },
    },
    async createCard(cardJson: unknown): Promise<{ cardId: string }> {
      const cardId = `card_fake_${nextCard++}`;
      cardById.set(cardId, cardJson);
      return { cardId };
    },
    async updateCardById(cardId: string, cardJson: unknown, sequence: number): Promise<void> {
      requests.push({ method: 'cardkit.v1.card.update', params: { cardId, cardJson, sequence } });
    },
    async updateCard(messageId: string, cardJson: unknown): Promise<void> {
      updatedCards.push({ messageId, card: cardJson });
      requests.push({ method: 'im.v1.message.patch', params: { messageId, cardJson } });
      const stored = byId.get(messageId);
      if (stored) stored.content = { card: cardJson };
    },
    async send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }> {
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
      return { messageId: landed.message_id };
    },
    getConnectionStatus() {
      return { state: 'connected' as const, reconnectAttempts: 0 };
    },
    async getAppInfo() {
      return { ownerId: 'ou_owner' };
    },
    async stream(chatId: string, input: unknown, options?: unknown): Promise<void> {
      const record: FakeChannelStream = {
        chatId,
        input,
        options,
        cardUpdates: [],
        markdownContents: [],
      };
      streams.push(record);

      if (isCardStreamInput(input)) {
        await input.card.producer({
          update: async (card: unknown): Promise<void> => {
            record.cardUpdates.push(card);
          },
        });
      }

      if (isMarkdownStreamInput(input)) {
        await input.markdown({
          setContent: async (markdown: string): Promise<void> => {
            record.markdownContents.push(markdown);
          },
        });
      }
    },
  };

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

interface FakeCardController {
  update(card: unknown): Promise<void>;
}

interface FakeMarkdownController {
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
