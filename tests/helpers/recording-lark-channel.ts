import { writeFile } from 'node:fs/promises';
import { createFakeChannel, type FakeChannel } from './fake-channel.js';

export interface RecordingLarkChannel extends FakeChannel {
  botIdentity: { openId: string; name: string };
  handlers: {
    message?: (msg: unknown) => Promise<void> | void;
    cardAction?: (evt: unknown) => Promise<unknown> | unknown;
    comment?: (evt: unknown) => Promise<void> | void;
    reconnecting?: () => void;
    reconnected?: () => void;
  };
  readonly callLog: RecordingCall[];
  readonly listChatsCalls: number;
  on(handlers: RecordingLarkChannel['handlers']): void;
  onRawEvent(eventType: string, handler: (data: unknown) => void): () => void;
  emit(event: 'reconnecting' | 'reconnected'): void;
  emitRaw(eventType: string, data: unknown): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  connectionState: 'connected' | 'reconnecting' | 'failed';
  forceReconnectCount: number;
  forceReconnect(): Promise<void>;
  getConnectionStatus(): { state: 'connected' | 'reconnecting' | 'failed'; reconnectAttempts: number };
  listChats(): Promise<Array<{ id: string; name: string }>>;
  getAppInfo(): Promise<{ ownerId: string }>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  recallMessage(messageId: string): Promise<void>;
  downloadResourceToFile(
    messageId: string,
    fileKey: string,
    type: string,
    destPath: string,
  ): Promise<{ contentType: string; bytesWritten: number }>;
  snapshotCalls(): RecordingCall[];
}

export type RecordingCall =
  | { op: 'send'; chatId: string; content: unknown; options: unknown }
  | { op: 'stream'; chatId: string; inputKind: 'card' | 'markdown' | 'other'; cardUpdates: unknown[]; markdownContents: string[] }
  | { op: 'updateCard'; messageId: string; card: unknown }
  | { op: 'updateCardById'; cardId: string; card: unknown }
  | { op: 'reaction.create'; messageId: string; emojiType: string }
  | { op: 'reaction.delete'; messageId: string; reactionId: string }
  | { op: 'recall'; messageId: string }
  | { op: 'download'; messageId: string; fileKey: string; type: string }
  | { op: 'raw'; method: string };

export function createRecordingLarkChannel(options: {
  botIdentity?: RecordingLarkChannel['botIdentity'];
  chats?: Array<{ id: string; name: string }>;
  messagesByChat?: Record<string, unknown[]>;
  chatMode?: 'group' | 'topic';
} = {}): RecordingLarkChannel {
  const inner = createFakeChannel();
  const callLog: RecordingCall[] = [];
  const handlers: RecordingLarkChannel['handlers'] = {};
  const rawHandlers = new Map<string, Set<(data: unknown) => void>>();
  let reactionSeq = 1;
  let listChatsCalls = 0;
  let forceReconnectCount = 0;

  const origSend = inner.send.bind(inner);
  const origStream = inner.stream.bind(inner);
  const origUpdateCard = inner.updateCard.bind(inner);
  const origUpdateCardById = inner.updateCardById.bind(inner);

  inner.send = async (chatId, content, options) => {
    const result = await origSend(chatId, content, options);
    callLog.push({ op: 'send', chatId, content: inner.sent.at(-1)?.content ?? content, options });
    return result;
  };

  const origList = inner.rawClient.im.v1.message.list.bind(inner.rawClient.im.v1.message);
  inner.rawClient.im.v1.message.list = async (params: unknown) => {
    const containerId = extractContainerId(params);
    const scripted = containerId ? options.messagesByChat?.[containerId] : undefined;
    if (scripted) {
      inner.rawClient.requests.push({ method: 'im.v1.message.list', params });
      return { data: { items: scripted, has_more: false } };
    }
    return origList(params);
  };

  inner.updateCard = async (messageId, cardJson) => {
    await origUpdateCard(messageId, cardJson);
    callLog.push({ op: 'updateCard', messageId, card: cardJson });
  };

  inner.updateCardById = async (cardId, cardJson, sequence) => {
    await origUpdateCardById(cardId, cardJson, sequence);
    callLog.push({ op: 'updateCardById', cardId, card: cardJson });
  };

  inner.stream = async (chatId, input, options) => {
    const inputKind = isCardStreamInput(input)
      ? 'card'
      : isMarkdownStreamInput(input)
        ? 'markdown'
        : 'other';
    const note = (): void => {
      const record = inner.streams.at(-1);
      callLog.push({
        op: 'stream',
        chatId,
        inputKind,
        cardUpdates: record?.cardUpdates ?? [],
        markdownContents: record?.markdownContents ?? [],
      });
    };
    try {
      const result = await origStream(chatId, input, options);
      note();
      return result;
    } catch (err) {
      note();
      throw err;
    }
  };

  const channel: RecordingLarkChannel = {
    ...inner,
    send: inner.send,
    stream: inner.stream,
    updateCard: inner.updateCard,
    updateCardById: inner.updateCardById,
    botIdentity: { ...(options.botIdentity ?? { openId: 'ou_bot', name: 'Pin Bot' }) },
    handlers,
    callLog,
    get listChatsCalls() {
      return listChatsCalls;
    },
    on(next) {
      Object.assign(handlers, next);
    },
    onRawEvent(eventType, handler) {
      let set = rawHandlers.get(eventType);
      if (!set) {
        set = new Set();
        rawHandlers.set(eventType, set);
      }
      set.add(handler);
      return () => { set.delete(handler); };
    },
    emit(event) {
      handlers[event]?.();
    },
    emitRaw(eventType, data) {
      for (const handler of rawHandlers.get(eventType) ?? []) handler(data);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return options.chatMode ?? 'group';
    },
    connectionState: 'connected',
    get forceReconnectCount() {
      return forceReconnectCount;
    },
    async forceReconnect() {
      forceReconnectCount += 1;
    },
    getConnectionStatus() {
      return { state: channel.connectionState, reconnectAttempts: 0 };
    },
    async listChats() {
      listChatsCalls += 1;
      return options.chats ?? [];
    },
    async getAppInfo() {
      return { ownerId: 'ou_owner' };
    },
    async addReaction(messageId, emojiType) {
      const reactionId = `reaction_${reactionSeq++}`;
      callLog.push({ op: 'reaction.create', messageId, emojiType });
      return reactionId;
    },
    async removeReaction(messageId, reactionId) {
      callLog.push({ op: 'reaction.delete', messageId, reactionId });
    },
    async recallMessage(messageId) {
      callLog.push({ op: 'recall', messageId });
    },
    async downloadResourceToFile(
      messageId: string,
      fileKey: string,
      type: string,
      destPath: string,
    ) {
      callLog.push({ op: 'download', messageId, fileKey, type });
      await writeFile(destPath, 'replayed-file');
      return { contentType: type === 'image' ? 'image/png' : 'application/octet-stream', bytesWritten: 13 };
    },
    snapshotCalls() {
      return structuredClone(callLog);
    },
  };

  return channel;
}

function extractContainerId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const nested = isRecord(params.params) ? params.params : params;
  return typeof nested.container_id === 'string' ? nested.container_id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCardStreamInput(value: unknown): boolean {
  return isRecord(value) && isRecord(value.card) && typeof value.card.producer === 'function';
}

function isMarkdownStreamInput(value: unknown): boolean {
  return isRecord(value) && typeof value.markdown === 'function';
}
