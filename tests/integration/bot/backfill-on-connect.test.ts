import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import { formatBackfillLatenessHint } from '../../../src/bot/backfill';
import * as logger from '../../../src/core/logger';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
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
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
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
    const hint = formatBackfillLatenessHint({ createTimeMs: first, nowMs: Date.now() });
    expect(prompt.split('以下用户消息是在 bot 离线期间发出的').length - 1).toBe(1);
    expect(prompt).toContain('first missed');
    expect(prompt).toContain('second missed');
    expect(prompt).toContain(hint.slice(0, 20));
    expect(info.mock.calls).toContainEqual([
      'prompt',
      'built',
      expect.objectContaining({ backfilled: 2 }),
    ]);
  });

  it('replies in-thread for a topic-group backfill', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    await startHarness({
      lastLiveAt: NOW - 5 * 60_000,
      chatMode: 'topic',
      chats: [{ id: TOPIC, name: 'Topic' }],
      messagesByChat: {
        [TOPIC]: [mentionItem('om_topic', TOPIC, 'topic missed', NOW - 90_000, 'omt_1')],
      },
    });
    await waitForDebounce();
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
    await waitFor(() => h.ledger.getLastBackfillEnd() !== undefined);
    await waitForDebounce();
    await yieldIO();
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
  threadId?: string,
): Record<string, unknown> {
  return {
    message_id: messageId,
    chat_id: chatId,
    msg_type: 'text',
    create_time: String(createTime),
    deleted: false,
    sender: { id: USER, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `@_user_1 ${text}` }) },
    mentions: [{ key: '@_user_1', id: BOT, id_type: 'open_id', name: 'Bot' }],
    ...(threadId ? { thread_id: threadId } : {}),
  };
}

async function waitForDebounce() {
  await new Promise((resolve) => setTimeout(resolve, 700));
}

async function waitFor(predicate: () => boolean) {
  for (let n = 0; n < 10_000; n++) {
    if (predicate()) return;
    await yieldIO();
  }
  throw new Error('expected backfill transition was not observed');
}
