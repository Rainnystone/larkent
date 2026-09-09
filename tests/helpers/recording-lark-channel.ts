import { createFakeChannel, type FakeChannel } from './fake-channel.js';

export interface RecordingLarkChannel extends FakeChannel {
  botIdentity: { openId: string; name: string };
  handlers: {
    message?: (msg: unknown) => Promise<void> | void;
    cardAction?: (evt: unknown) => Promise<void> | void;
    comment?: (evt: unknown) => Promise<void> | void;
  };
  readonly callLog: RecordingCall[];
  on(handlers: RecordingLarkChannel['handlers']): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  listChats(): Promise<Array<{ id: string; name: string }>>;
  getAppInfo(): Promise<{ ownerId: string }>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  recallMessage(messageId: string): Promise<void>;
  snapshotCalls(): RecordingCall[];
}

export type RecordingCall =
  | { op: 'send'; chatId: string; content: unknown; options: unknown }
  | { op: 'stream'; chatId: string; inputKind: 'card' | 'markdown' | 'other'; cardUpdates: unknown[]; markdownContents: string[] }
  | { op: 'reaction.create'; messageId: string; emojiType: string }
  | { op: 'reaction.delete'; messageId: string; reactionId: string }
  | { op: 'recall'; messageId: string }
  | { op: 'raw'; method: string };

export function createRecordingLarkChannel(options: {
  botIdentity?: RecordingLarkChannel['botIdentity'];
} = {}): RecordingLarkChannel {
  const inner = createFakeChannel();
  const callLog: RecordingCall[] = [];
  const handlers: RecordingLarkChannel['handlers'] = {};
  let reactionSeq = 1;

  const origSend = inner.send.bind(inner);
  const origStream = inner.stream.bind(inner);

  inner.send = async (chatId, content, options) => {
    const result = await origSend(chatId, content, options);
    callLog.push({ op: 'send', chatId, content: inner.sent.at(-1)?.content ?? content, options });
    return result;
  };

  inner.stream = async (chatId, input, options) => {
    await origStream(chatId, input, options);
    const record = inner.streams.at(-1);
    const inputKind = isCardStreamInput(input)
      ? 'card'
      : isMarkdownStreamInput(input)
        ? 'markdown'
        : 'other';
    callLog.push({
      op: 'stream',
      chatId,
      inputKind,
      cardUpdates: record?.cardUpdates ?? [],
      markdownContents: record?.markdownContents ?? [],
    });
  };

  const channel: RecordingLarkChannel = {
    ...inner,
    send: inner.send,
    stream: inner.stream,
    botIdentity: { ...(options.botIdentity ?? { openId: 'ou_bot', name: 'Pin Bot' }) },
    handlers,
    callLog,
    on(next) {
      Object.assign(handlers, next);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async listChats() {
      return [];
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
    snapshotCalls() {
      return structuredClone(callLog);
    },
  };

  return channel;
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
