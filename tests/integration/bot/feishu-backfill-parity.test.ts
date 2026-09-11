import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { AGENT_KINDS, type AgentKind } from '../../../src/agent/registry.js';
import { BackfillLedger } from '../../../src/bot/backfill-ledger.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: () => {
      if (!sdk.channel) throw new Error('recording channel not configured');
      return sdk.channel;
    },
  };
});

import { startChannel } from '../../../src/bot/channel.js';

const BOT = 'ou_bot';
const USER = 'ou_user';
const GROUP = 'oc_group';
const TOPIC = 'oc_topic';
const MSG = 'om_missed';
const THREAD = 'omt_1';
const TEXT = 'please answer the missed mention';
const ANSWER = 'PINNED_ANSWER';
const HINT = '以下用户消息是在 bot 离线期间发出的';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdk.channel = undefined;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Feishu live vs backfill parity', () => {
  it.each(AGENT_KINDS)(
    '%s backfilled group mention matches live outbound and adds one hint line',
    async (kind) => {
      const createTime = Date.now() - 90_000;
      const live = await runOnce({ kind, path: 'live', chatMode: 'group', createTime });
      const backfilled = await runOnce({ kind, path: 'backfill', chatMode: 'group', createTime });

      expect(backfilled.outbound).toEqual(live.outbound);
      expect(hintCount(live.prompt)).toBe(0);
      expect(hintCount(backfilled.prompt)).toBe(1);
      expect(stripHint(backfilled.prompt)).toEqual(live.prompt);
      expect(live.replyTo).toBe(MSG);
      expect(backfilled.replyTo).toBe(MSG);
    },
    20_000,
  );

  it.each(AGENT_KINDS)(
    '%s topic-group live and backfill reply in-thread to the missed message',
    async (kind) => {
      const createTime = Date.now() - 90_000;
      const live = await runOnce({
        kind,
        path: 'live',
        chatMode: 'topic',
        createTime,
        threadId: THREAD,
      });
      const backfilled = await runOnce({
        kind,
        path: 'backfill',
        chatMode: 'topic',
        createTime,
        threadId: THREAD,
      });

      expect(backfilled.outbound).toEqual(live.outbound);
      expect(hintCount(live.prompt)).toBe(0);
      expect(hintCount(backfilled.prompt)).toBe(1);
      expect(stripHint(backfilled.prompt)).toEqual(live.prompt);
      expect(live.replyTo).toBe(MSG);
      expect(backfilled.replyTo).toBe(MSG);
      expect(live.replyInThread).toBe(true);
      expect(backfilled.replyInThread).toBe(true);
    },
    20_000,
  );
});

async function runOnce(opts: {
  kind: AgentKind;
  path: 'live' | 'backfill';
  chatMode: 'group' | 'topic';
  createTime: number;
  threadId?: string;
}): Promise<{
  prompt: string;
  outbound: unknown[];
  replyTo: string | undefined;
  replyInThread: boolean;
}> {
  const chatId = opts.chatMode === 'topic' ? TOPIC : GROUP;
  const tmp = await createTmpProfile(`feishu-backfill-parity-${opts.kind}-`);
  const file = `${tmp.profile}/backfill-state.json`;
  const ledger = new BackfillLedger(file);
  await ledger.load();
  ledger.touchLive(opts.path === 'live' ? Date.now() : Date.now() - 5 * 60_000);

  const cfg = createDefaultProfileConfig({
    agentKind: opts.kind,
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], admins: [USER] },
    preferences: {
      messageReply: 'text',
      cotMessages: 'off',
      requireMentionInGroup: true,
    },
    ...(opts.kind === 'codex'
      ? { codex: { binaryPath: '/usr/local/bin/codex', inheritCodexHome: false } }
      : {}),
  });
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const agent = new FakeAgentAdapter({
    id: opts.kind,
    events: [
      { type: 'text', delta: ANSWER },
      { type: 'final_text', content: ANSWER },
      { type: 'done', terminationReason: 'normal' },
    ],
  });
  const channel = createRecordingLarkChannel({
    botIdentity: { openId: BOT, name: 'Bot' },
    chats: [{ id: chatId, name: 'Group' }],
    messagesByChat: opts.path === 'backfill'
      ? { [chatId]: [mentionItem(chatId, opts.createTime, opts.threadId)] }
      : {},
    chatMode: opts.chatMode,
  });
  if (opts.threadId) channel.rawThreadIds.set(MSG, opts.threadId);
  sdk.channel = channel;

  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    ledger,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      ownerRefreshState: 'ok',
      botOwnerId: USER,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: `${tmp.root}/config.json`,
      processId: `parity-${opts.kind}`,
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });

  if (opts.path === 'live') {
    await channel.handlers.message?.(liveMention(chatId, opts.createTime, opts.threadId));
  } else {
    await waitFor(() => ledger.getLastBackfillEnd() !== undefined);
  }

  await waitForDebounce();
  await waitFor(() => agent.runOptions.length === 1);
  await waitFor(() => channel.streams.length + channel.sent.length > 0);

  const reply = replyTarget(channel);
  return {
    prompt: agent.runOptions[0]!.prompt,
    outbound: outboundSequence(channel),
    replyTo: reply.replyTo,
    replyInThread: reply.replyInThread,
  };
}

function mentionItem(
  chatId: string,
  createTime: number,
  threadId?: string,
): Record<string, unknown> {
  return {
    message_id: MSG,
    chat_id: chatId,
    msg_type: 'text',
    create_time: String(createTime),
    deleted: false,
    sender: { id: USER, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `@_user_1 ${TEXT}` }) },
    mentions: [{ key: '@_user_1', id: BOT, id_type: 'open_id', name: 'Bot' }],
    ...(threadId ? { thread_id: threadId } : {}),
  };
}

function liveMention(
  chatId: string,
  createTime: number,
  threadId?: string,
): NormalizedMessage {
  return {
    messageId: MSG,
    content: TEXT,
    chatId,
    chatType: 'group',
    senderId: USER,
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime,
    mentions: [{ key: '@_user_1', openId: BOT, name: 'Bot', isBot: true }],
    mentionAll: false,
    ...(threadId ? { threadId } : {}),
  } as unknown as NormalizedMessage;
}

function outboundSequence(
  channel: ReturnType<typeof createRecordingLarkChannel>,
): unknown[] {
  return [
    ...channel.streams.map((row) => ({
      op: 'stream',
      chatId: row.chatId,
      markdownContents: row.markdownContents,
      options: row.options,
    })),
    ...channel.sent.map((row) => ({
      op: 'send',
      chatId: row.chatId,
      content: row.content,
      options: row.options,
    })),
  ];
}

function replyTarget(channel: ReturnType<typeof createRecordingLarkChannel>): {
  replyTo: string | undefined;
  replyInThread: boolean;
} {
  const options = channel.streams.at(0)?.options ?? channel.sent.at(0)?.options;
  const record = isRecord(options) ? options : {};
  return {
    replyTo: typeof record.replyTo === 'string' ? record.replyTo : undefined,
    replyInThread: record.replyInThread === true,
  };
}

function hintCount(prompt: string): number {
  return prompt.split(HINT).length - 1;
}

function stripHint(prompt: string): string {
  return prompt.replace(/,?\s*"以下用户消息是在 bot 离线期间发出的[^"]*"/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function waitForDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 700));
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for live/backfill parity sequence');
}
