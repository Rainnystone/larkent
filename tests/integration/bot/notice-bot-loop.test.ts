import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { CONTINUE_HINT } from '../../../src/bot/interruption-notice';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({
  queue: [] as Array<ReturnType<typeof createRecordingLarkChannel>>,
}));
vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => {
    const next = sdk.queue.shift();
    if (!next) throw new Error('fake channel not queued');
    return next;
  },
}));
import { startChannel } from '../../../src/bot/channel';

const CHAT = 'oc_group';
const HUMAN = 'ou_user';
const BOT_A = 'ou_bot_a';
const BOT_B = 'ou_bot_b';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  sdk.queue = [];
});

describe('bot-initiated interruption notices', { timeout: 20_000 }, () => {
  it('does not start a second run when two failing bridges notice each other', async () => {
    const channelA = createRecordingLarkChannel({
      chats: [{ id: CHAT, name: 'G' }],
      botIdentity: { openId: BOT_A, name: 'BotA' },
    });
    const channelB = createRecordingLarkChannel({
      chats: [{ id: CHAT, name: 'G' }],
      botIdentity: { openId: BOT_B, name: 'BotB' },
    });
    routeMentions(channelA, channelB);
    routeMentions(channelB, channelA);
    const a = await startBridge({ openId: BOT_A, appId: 'cli_a', name: 'BotA', channel: channelA });
    const b = await startBridge({ openId: BOT_B, appId: 'cli_b', name: 'BotB', channel: channelB });

    await a.channel.handlers.message?.(botMention({
      messageId: 'om_seed',
      senderId: BOT_B,
      targetOpenId: BOT_A,
      content: '@BotA 请接着处理',
    }));
    await waitFor(() => a.agent.runOptions.length === 1);
    await waitFor(() => noticeBodies(a.channel).length === 1);
    expect(noticeBodies(a.channel).join('\n')).not.toMatch(/<at\b/);

    await new Promise((resolve) => setTimeout(resolve, 800));
    await yieldIO();
    expect(b.agent.runOptions).toHaveLength(0);
    expect(noticeBodies(b.channel)).toHaveLength(0);
  });

  it('still structurally @mentions a human initiator', async () => {
    const h = await startBridge({ openId: BOT_A, appId: 'cli_a', name: 'BotA' });
    await h.channel.handlers.message?.(humanMention('om_human', '请处理'));
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(() => noticeBodies(h.channel).length === 1);
    expect(noticeBodies(h.channel).join('\n')).toContain(`<at id="${HUMAN}"></at>`);
  });
});

async function startBridge(opts: {
  openId: string;
  appId: string;
  name: string;
  channel?: ReturnType<typeof createRecordingLarkChannel>;
}) {
  const tmp = await createTmpProfile(`notice-bot-loop-${opts.appId}-`);
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'));
  await journal.load();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: opts.appId, secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [HUMAN], allowedChats: [CHAT], admins: [HUMAN] },
    preferences: {
      messageReply: 'text',
      messageReplyMigrated: true,
      cotMessages: 'off',
      requireMentionInGroup: true,
    },
  });
  cfg.workspaces.default = tmp.workspace;
  const agent = new FakeAgentAdapter({
    id: 'claude',
    events: [[{ type: 'done', terminationReason: 'interrupted' }]],
  });
  const channel = opts.channel ?? createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
    botIdentity: { openId: opts.openId, name: opts.name },
  });
  sdk.queue.push(channel);
  const bridge = await startChannel({
    cfg,
    agent,
    sessions: new SessionStore(join(tmp.profile, 'sessions.json')),
    workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')),
    journal,
    probe: async () => true,
    appPaths: {
      mediaDir,
      secretsFile: join(tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(tmp.profile, '.keystore.salt'),
    },
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      botOwnerId: HUMAN,
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: `test-notice-loop-${opts.appId}`,
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, agent, journal, bridge };
}

function routeMentions(
  from: ReturnType<typeof createRecordingLarkChannel>,
  to: ReturnType<typeof createRecordingLarkChannel>,
): void {
  const orig = from.send.bind(from);
  from.send = async (...args: Parameters<typeof orig>) => {
    const result = await orig(...args);
    const json = JSON.stringify(args[1]);
    if (json.includes(`<at id="${to.botIdentity.openId}"`)) {
      void to.handlers.message?.(botMention({
        messageId: `om_from_${from.botIdentity.openId}_${Date.now()}`,
        senderId: from.botIdentity.openId,
        targetOpenId: to.botIdentity.openId,
        content: CONTINUE_HINT,
      }));
    }
    return result;
  };
}

function botMention(input: {
  messageId: string;
  senderId: string;
  targetOpenId: string;
  content: string;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    content: input.content,
    chatId: CHAT,
    chatType: 'group',
    senderId: input.senderId,
    senderName: 'PeerBot',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    mentions: [{ key: '@_user_1', openId: input.targetOpenId, name: 'Bot', isBot: true }],
    createTime: Date.now(),
    raw: {
      sender: { id: input.senderId, sender_type: 'app' },
    },
  } as unknown as NormalizedMessage;
}

function humanMention(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: CHAT,
    chatType: 'group',
    senderId: HUMAN,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime: Date.now(),
    raw: {
      sender: { id: HUMAN, sender_type: 'user' },
    },
  } as unknown as NormalizedMessage;
}

function noticeBodies(channel: ReturnType<typeof createRecordingLarkChannel>): string[] {
  return channel.sent
    .map((item) => JSON.stringify(item.content).replace(/\\"/g, '"'))
    .filter((json) => json.includes(CONTINUE_HINT) || json.includes('上一轮未完成'));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected notice-bot-loop transition was not observed');
}
