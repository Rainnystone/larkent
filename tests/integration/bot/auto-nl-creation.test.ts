import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { AutomationsStore } from '../../../src/automations/store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent';
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

const CHAT = 'oc_group';
const USER = 'ou_user';
const MATE = 'ou_mate';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const VISIBLE = '好的，10 分钟后提醒你交周报。';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('legacy reply from an app sender', () => {
  it('keeps an old tag inert in a bot-sent mention', async () => {
    const h = await harness({
      events: [{
        type: 'text',
        delta: `${VISIBLE}\n${proposalXml({
          taskType: 'reminder',
          schedule: '10 分钟后',
          name: '交周报',
          taskText: '提醒我交周报',
        })}`,
      }, { type: 'done', terminationReason: 'normal' }],
    });
    await h.channel.handlers.message?.(mention('om_bot', '10 分钟后提醒我交周报', {
      senderId: 'ou_other_bot',
      senderType: 'app',
    }));
    await waitFor(() => markdownSends(h).some((text) => text.includes(VISIBLE) && !text.includes('automation_proposal')));
    expect(h.channel.sent.some((item) => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
    expect(h.store.listDrafts()).toEqual([]);
    expect(h.store.list()).toEqual([]);
    expect(await h.store.readLog()).toEqual([]);
  }, 15_000);

});

async function harness(opts: {
  events?: FakeAgentEvents;
  enabled?: boolean;
  replyMode?: 'text' | 'markdown' | 'card';
  agentKind?: 'claude' | 'codex';
  linkDown?: boolean;
} = {}) {
  const tmp = await createTmpProfile('auto-nl-');
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  let nowMs = NOW;
  const now = () => nowMs;
  const statusPath = join(tmp.profile, 'automations-status.json');
  const store = new AutomationsStore({
    path: join(tmp.profile, 'automations.json'),
    logPath: join(tmp.profile, 'automations.log'),
    statusPath,
    now,
  });
  await store.load();
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'), { now });
  await journal.load();
  const agentKind = opts.agentKind ?? 'claude';
  const cfg = createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: {
      allowedUsers: [USER, MATE, 'ou_other_bot'],
      allowedChats: [CHAT],
    },
    preferences: {
      requireMentionInGroup: true,
      messageReply: opts.replyMode ?? 'text',
      messageReplyMigrated: true,
      cotMessages: 'off',
    },
    ...(agentKind === 'codex'
      ? { codex: { binaryPath: '/usr/local/bin/codex', inheritCodexHome: false } }
      : {}),
  });
  cfg.automations = {
    enabled: opts.enabled ?? true,
    agentTasks: false,
    timezone: 'Asia/Shanghai',
  };
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(CHAT, tmp.workspace);
  const agent = new FakeAgentAdapter({
    id: agentKind,
    events: opts.events ?? [],
  });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
    chatMode: 'group',
    botIdentity: { openId: 'ou_bot', name: 'Pin Bot' },
  });
  if (opts.linkDown) channel.connectionState = 'reconnecting';
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    automations: store,
    journal,
    now,
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
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-auto-nl',
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await store.flush().catch(() => {});
    await journal.flush().catch(() => {});
    await tmp.cleanup();
  });
  return {
    channel,
    store,
    journal,
    agent,
    statusPath,
    tmp,
    bridge,
    setNow(next: number) {
      nowMs = next;
    },
  };
}

function proposalXml(fields: Record<string, unknown>): string {
  return `<automation_proposal>\n${JSON.stringify(fields)}\n</automation_proposal>`;
}

function mention(
  messageId: string,
  content: string,
  extra: {
    senderId?: string;
    chatType?: 'p2p' | 'group';
    senderType?: 'user' | 'app' | 'bot';
  } = {},
): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: extra.chatType === 'p2p' ? 'oc_dm' : CHAT,
    chatType: extra.chatType ?? 'group',
    senderId: extra.senderId ?? USER,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime: NOW,
    raw: {
      sender: {
        sender_type: extra.senderType ?? 'user',
        sender_id: { open_id: extra.senderId ?? USER },
      },
    },
  } as unknown as NormalizedMessage;
}

function markdownSends(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string[] {
  return h.channel.sent.flatMap((item) => {
    const content = item.content as { markdown?: unknown };
    return typeof content?.markdown === 'string' ? [content.markdown] : [];
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected natural-language automation confirm card was not observed');
}
