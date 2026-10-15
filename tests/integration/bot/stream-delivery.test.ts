import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: { v6: { application: { get: ReturnType<typeof vi.fn> } } };
    im: {
      v1: {
        message: { get: ReturnType<typeof vi.fn> };
        messageReaction: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];
type ReplyMode = 'card' | 'markdown';

const PROGRESS = 'progress update';
const ANSWER = 'FINAL_SENTINEL';
const NOTICE = '⚠️ agent 失败';
const GRACE_MS = 3_500;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe.each(['card', 'markdown'] as const)('stream delivery (%s)', (mode) => {
  it('sends one final when the first update rejects', async () => {
    const gate = controllableWrites({ failIf: () => true });
    const h = await harness(mode, {
      events: [
        { type: 'text', delta: ANSWER },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: gate.stream,
    });
    await startBridge(h);
    await h.channel.handlers.message?.(message('om_reject', 'run'));
    await waitFor(() => h.channel.sent.length === 1, 8_000);
    expect(h.channel.sent).toHaveLength(1);
    expect(payload(h.channel.sent[0]?.content)).toContain(ANSWER);
  }, 10_000);

  it('sends one final when the first update hangs past grace then rejects', async () => {
    const gate = controllableWrites();
    const h = await harness(mode, {
      events: [
        { type: 'text', delta: ANSWER },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: gate.stream,
    });
    await startBridge(h);
    await h.channel.handlers.message?.(message('om_hang_reject', 'run'));
    await waitFor(() => gate.writes.length >= 1);
    await sleep(GRACE_MS);
    gate.writes[0]!.deferred.reject(new Error('late first render failed'));
    await waitFor(() => h.channel.sent.length === 1, 8_000);
    expect(h.channel.sent).toHaveLength(1);
    expect(payload(h.channel.sent[0]?.content)).toContain(ANSWER);
  }, 15_000);

  it('does not duplicate when the first update hangs past grace then resolves', async () => {
    const gate = controllableWrites();
    const h = await harness(mode, {
      events: [
        { type: 'text', delta: ANSWER },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: gate.stream,
    });
    await startBridge(h);
    await h.channel.handlers.message?.(message('om_hang_ok', 'run'));
    await waitFor(() => gate.writes.length >= 1);
    await sleep(GRACE_MS);
    for (const write of gate.writes) write.deferred.resolve();
    await sleep(200);
    const streamed = gate.writes.some((row) => row.payload.includes(ANSWER));
    const finals = h.channel.sent.filter((row) => payload(row.content).includes(ANSWER));
    expect(streamed || finals.length === 1).toBe(true);
    expect(streamed && finals.length > 0).toBe(false);
  }, 15_000);

  it('re-renders latestState when the first update is slower than the run', async () => {
    const gate = controllableWrites();
    const h = await harness(mode, {
      events: [
        { type: 'text', delta: PROGRESS },
        { type: 'text', delta: ` ${ANSWER}` },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: gate.stream,
    });
    await startBridge(h);
    await h.channel.handlers.message?.(message('om_slow', 'run'));
    await waitFor(() => gate.writes.length >= 1);
    gate.writes[0]!.deferred.resolve();
    await waitFor(() => gate.writes.some((row) => row.payload.includes(ANSWER)));
    const last = gate.writes.at(-1)!;
    last.deferred.resolve();
    for (const write of gate.writes) write.deferred.resolve();
    await sleep(80);
    expect(gate.writes.at(-1)?.payload).toContain(ANSWER);
    expect(gate.writes.at(-1)?.payload).not.toContain('正在输出');
  }, 10_000);

  it('sends a final including the notice when the terminal update fails', async () => {
    const gate = controllableWrites({
      failIf: (body) => body.includes(NOTICE) || body.includes('已完成') || body.includes('出错'),
      autoResolve: true,
    });
    const h = await harness(mode, {
      events: [
        { type: 'text', delta: PROGRESS },
        { type: 'error', message: 'boom', terminationReason: 'failed' },
      ],
      stream: gate.stream,
    });
    await startBridge(h);
    await h.channel.handlers.message?.(message('om_term_fail', 'run'));
    await waitFor(() => h.channel.sent.length === 1, 8_000);
    expect(payload(h.channel.sent[0]?.content)).toMatch(/agent 失败/);
  });

  it('does not send a duplicate notice when the rendered terminal already includes it', async () => {
    const gate = controllableWrites({ autoResolve: true });
    const h = await harness(mode, {
      events: [
        { type: 'text', delta: PROGRESS },
        { type: 'error', message: 'boom', terminationReason: 'failed' },
      ],
      stream: gate.stream,
    });
    await startBridge(h);
    await h.channel.handlers.message?.(message('om_notice_once', 'run'));
    await waitFor(() => gate.writes.some((row) => /agent 失败/.test(row.payload)));
    for (const write of gate.writes) write.deferred.resolve();
    await sleep(200);
    const streamHits = gate.writes.filter((row) => /agent 失败/.test(row.payload)).length;
    expect(streamHits).toBeGreaterThanOrEqual(1);
    expect(h.channel.sent).toHaveLength(0);
  });
});

function controllableWrites(opts: {
  failIf?: (body: string) => boolean;
  autoResolve?: boolean;
} = {}): {
  writes: Array<{ payload: string; deferred: Deferred<void> }>;
  stream: StreamFn;
} {
  const writes: Array<{ payload: string; deferred: Deferred<void> }> = [];
  const stream: StreamFn = async (_chatId, input) => {
    const write = async (body: string): Promise<void> => {
      if (opts.failIf?.(body)) throw new Error(writes.length === 0 ? 'first render failed' : 'terminal render failed');
      const item = { payload: body, deferred: deferred<void>() };
      writes.push(item);
      if (opts.autoResolve) item.deferred.resolve();
      await item.deferred.promise;
    };
    const card = (input as {
      card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
    }).card?.producer;
    const markdown = (input as {
      markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
    }).markdown;
    if (card) {
      await card({ update: async (next) => write(JSON.stringify(next)) });
    } else if (markdown) {
      await markdown({ setContent: async (text) => write(text) });
    }
  };
  return { writes, stream };
}

async function harness(mode: ReplyMode, options: { events: FakeAgentEvents; stream: StreamFn }) {
  const tmp = await createTmpProfile('stream-delivery-');
  const workspace = await realpath(tmp.workspace);
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: mode, cotMessages: 'off' },
  });
  profileConfig.workspaces.default = workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'claude',
    displayName: 'claude',
    events: options.events,
  });
  const channel = createFakeLarkChannel(options.stream);
  sdkMock.channel = channel;
  const controls = {
    profile: 'claude',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, agent, sessions, workspaces, profileConfig, controls };
}

async function startBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: {
    profile: string;
    profileConfig: ReturnType<typeof createDefaultProfileConfig>;
    ownerRefreshState: 'unknown';
    refreshOwner(): Promise<void>;
    restart(): Promise<void>;
    exit(): Promise<void>;
    configPath: string;
    cfg: ReturnType<typeof createDefaultProfileConfig>;
    processId: string;
  };
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(stream: StreamFn): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: { application: { get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })) } },
      },
      im: {
        v1: {
          message: { get: vi.fn(async () => ({ data: { items: [] } })) },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
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
    async send(_chatId, content, options) {
      sent.push({ chatId: _chatId, content, options });
      return { messageId: `sent_${sent.length}` };
    },
    stream,
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function payload(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && 'markdown' in content) {
    return String((content as { markdown?: unknown }).markdown ?? '');
  }
  return JSON.stringify(content ?? '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('timed out waiting for stream-delivery behaviour');
}
