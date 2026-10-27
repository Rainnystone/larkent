import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import { formatBackfillLatenessHint } from '../../../src/bot/backfill';
import * as logger from '../../../src/core/logger';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel, isBackfillDelayLine } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
}));
vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const NOW = 1_760_000_000_000;
const BOT = 'ou_bot';
const USER = 'ou_user';
const CHAT = 'oc_group';
const TOPIC = 'oc_topic';
const OUTSIDER = 'ou_outsider';
const PROFILE_TZ = 'Europe/Berlin';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('backfill on connect', () => {
  it('initializes a missing watermark and does not start a run', async () => {
    const h = await startHarness({ lastLiveAt: undefined });
    await waitFor(() => h.ledger.getLiveAt() !== undefined);
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('hands missed mentions to intake and adds one lateness hint for a merged batch', async () => {
    const first = NOW - 12 * 60_000;
    const second = NOW - 11 * 60_000;
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await startHarness({
      lastLiveAt: NOW - 5 * 60_000,
      chats: [{ id: CHAT, name: 'Group' }],
      messagesByChat: {
        [CHAT]: [
          mentionItem('om_late_1', CHAT, 'first missed', first),
          mentionItem('om_late_2', CHAT, 'second missed', second),
        ],
      },
    });
    await waitFor(() => h.ledger.getLastBackfillEnd() !== undefined);
    await waitForDebounce();
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]!.prompt;
    const hint = formatBackfillLatenessHint({
      createTimeMs: first, nowMs: Date.now(), timeZone: PROFILE_TZ, delayAnnounced: true,
    });
    expect(prompt.split('以下用户消息发于').length - 1).toBe(1);
    expect(prompt).toContain('first missed');
    expect(prompt).toContain('second missed');
    expect(prompt).toContain(hint.slice(0, hint.indexOf('（')));
    expect(prompt).toContain(hint.slice(hint.indexOf('理解。')));
    const delayLines = h.channel.callLog.filter((call) => (
      call.op === 'send' && isBackfillDelayLine(call)
    ));
    expect(delayLines).toEqual([
      expect.objectContaining({ chatId: CHAT, options: expect.objectContaining({ replyTo: 'om_late_1' }) }),
    ]);
    expect(h.channel.callLog.findIndex((call) => call.op === 'send' || call.op === 'stream'))
      .toBe(h.channel.callLog.indexOf(delayLines[0]!));
    expect(info.mock.calls).toContainEqual([
      'prompt',
      'built',
      expect.objectContaining({ backfilled: 2 }),
    ]);
  });

  it('tells the agent to acknowledge the late reply itself when the delay line could not be posted', async () => {
    const createTime = NOW - 12 * 60_000;
    const h = await startHarness({
      lastLiveAt: NOW - 5 * 60_000,
      failFirstSend: true,
      chats: [{ id: CHAT, name: 'Group' }],
      messagesByChat: { [CHAT]: [mentionItem('om_late', CHAT, 'missed ask', createTime)] },
    });
    await waitFor(() => h.ledger.getLastBackfillEnd() !== undefined);
    await waitForDebounce();
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]!.prompt;
    const unannounced = formatBackfillLatenessHint({
      createTimeMs: createTime, nowMs: Date.now(), timeZone: PROFILE_TZ, delayAnnounced: false,
    });
    expect(delayLines(h.channel)).toEqual([]);
    expect(prompt).toContain(unannounced.slice(unannounced.indexOf('理解。')));
    expect(prompt).not.toContain('bridge 已自行告知延迟');
  });

  it('replies in-thread for a topic-group backfill', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await startHarness({
      lastLiveAt: NOW - 5 * 60_000,
      chatMode: 'topic',
      chats: [{ id: TOPIC, name: 'Topic' }],
      messagesByChat: {
        [TOPIC]: [mentionItem('om_topic', TOPIC, 'topic missed', NOW - 90_000, { threadId: 'omt_1' })],
      },
    });
    await waitForDebounce();
    await waitFor(() =>
      info.mock.calls.some((call) => call[0] === 'flush' && call[1] === 'reply-target'),
    );
    expect(info.mock.calls).toContainEqual([
      'flush',
      'reply-target',
      expect.objectContaining({
        chatId: TOPIC,
        threadId: 'omt_1',
        replyTo: 'om_topic',
        replyInThread: true,
      }),
    ]);
    expect(h.channel.callLog.filter((call) => (
      call.op === 'send' && isBackfillDelayLine(call)
    ))).toEqual([
      expect.objectContaining({
        chatId: TOPIC,
        options: expect.objectContaining({ replyTo: 'om_topic', replyInThread: true }),
      }),
    ]);
  });

  it('threads the delay line under each topic opener whose thread only the raw lookup recovers', async () => {
    const h = await startHarness({
      lastLiveAt: NOW - 5 * 60_000,
      chatMode: 'topic',
      chats: [{ id: TOPIC, name: 'Topic' }],
      messagesByChat: {
        [TOPIC]: [
          mentionItem('om_open_a', TOPIC, 'first topic', NOW - 90_000),
          mentionItem('om_open_b', TOPIC, 'second topic', NOW - 80_000),
        ],
      },
      rawThreadIds: { om_open_a: 'omt_a', om_open_b: 'omt_b' },
    });
    await waitFor(() => h.ledger.getLastBackfillEnd() !== undefined);
    await waitForDebounce();
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(delayLines(h.channel)).toEqual([
      expect.objectContaining({
        chatId: TOPIC,
        options: expect.objectContaining({ replyTo: 'om_open_a', replyInThread: true }),
      }),
      expect.objectContaining({
        chatId: TOPIC,
        options: expect.objectContaining({ replyTo: 'om_open_b', replyInThread: true }),
      }),
    ]);
  });

  it('posts the delay line only for a sender the access fence lets through', async () => {
    const h = await startHarness({
      lastLiveAt: NOW - 5 * 60_000,
      fence: true,
      chats: [{ id: CHAT, name: 'Group' }],
      messagesByChat: {
        [CHAT]: [
          mentionItem('om_fenced', CHAT, 'outsider ask', NOW - 12 * 60_000, { senderId: OUTSIDER }),
          mentionItem('om_allowed', CHAT, 'member ask', NOW - 11 * 60_000),
        ],
      },
    });
    await waitFor(() => h.ledger.getLastBackfillEnd() !== undefined);
    await waitForDebounce();
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions[0]!.prompt).not.toContain('outsider ask');
    expect(delayLines(h.channel)).toEqual([
      expect.objectContaining({ chatId: CHAT, options: expect.objectContaining({ replyTo: 'om_allowed' }) }),
    ]);
  });

  it('dryRun logs would-enqueue and never starts an agent run', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await startHarness({
      lastLiveAt: NOW - 5 * 60_000,
      dryRun: true,
      chats: [{ id: CHAT, name: 'Group' }],
      messagesByChat: {
        [CHAT]: [mentionItem('om_dry', CHAT, 'would run', NOW - 90_000)],
      },
    });
    await waitFor(() =>
      info.mock.calls.some((call) => call[0] === 'backfill' && call[1] === 'would-enqueue'),
    );
    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.ledger.has('om_dry')).toBe(false);
    expect(info.mock.calls).toContainEqual([
      'backfill',
      'would-enqueue',
      expect.objectContaining({ msgId: 'om_dry' }),
    ]);
  });
});

async function startHarness(opts: {
  lastLiveAt?: number;
  dryRun?: boolean;
  chats?: Array<{ id: string; name: string }>;
  messagesByChat?: Record<string, unknown[]>;
  chatMode?: 'group' | 'topic';
  fence?: boolean;
  rawThreadIds?: Record<string, string>;
  failFirstSend?: boolean;
}) {
  const tmp = await createTmpProfile('backfill-connect-');
  const file = `${tmp.profile}/backfill-state.json`;
  const ledger = new BackfillLedger(file, { now: () => NOW });
  await ledger.load();
  if (opts.lastLiveAt !== undefined) ledger.touchLive(opts.lastLiveAt);
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], admins: [USER] },
    preferences: {
      messageReply: 'text',
      cotMessages: 'off',
      requireMentionInGroup: true,
      ...(opts.dryRun ? { backfill: { dryRun: true } } : {}),
    },
  });
  cfg.workspaces.default = tmp.workspace;
  cfg.automations.timezone = PROFILE_TZ;
  if (opts.fence) {
    cfg.access.allowedChats = [CHAT];
    cfg.access.fence = { enabled: true };
  }
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const agent = new FakeAgentAdapter({
    id: 'claude',
    events: [
      { type: 'text', delta: 'late answer' },
      { type: 'done', terminationReason: 'normal' },
    ],
  });
  const channel = createRecordingLarkChannel({
    botIdentity: { openId: BOT, name: 'Bot' },
    chats: opts.chats,
    messagesByChat: opts.messagesByChat,
    chatMode: opts.chatMode,
  });
  for (const [messageId, threadId] of Object.entries(opts.rawThreadIds ?? {})) {
    channel.rawThreadIds.set(messageId, threadId);
  }
  if (opts.failFirstSend) channel.sendErrors.send = new Error('send failed');
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
      processId: 'test-backfill',
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, agent, ledger };
}

function mentionItem(
  messageId: string,
  chatId: string,
  text: string,
  createTime: number,
  extra: { threadId?: string; senderId?: string } = {},
): Record<string, unknown> {
  return {
    message_id: messageId,
    chat_id: chatId,
    msg_type: 'text',
    create_time: String(createTime),
    deleted: false,
    sender: { id: extra.senderId ?? USER, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `@_user_1 ${text}` }) },
    mentions: [{ key: '@_user_1', id: BOT, id_type: 'open_id', name: 'Bot' }],
    ...(extra.threadId ? { thread_id: extra.threadId } : {}),
  };
}

function delayLines(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return channel.callLog.filter((call) => call.op === 'send' && isBackfillDelayLine(call));
}

async function waitForDebounce() {
  await new Promise((resolve) => setTimeout(resolve, 700));
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected backfill transition was not observed');
}
