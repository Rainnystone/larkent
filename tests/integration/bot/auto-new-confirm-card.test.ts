import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatFireKey } from '../../../src/automations/schedule';
import { AUTOMATIONS_DRAFT_TTL_MS, AutomationsStore } from '../../../src/automations/store';
import { AUTO_INVALID_HINT, AUTO_LEAD_TOO_SOON, AUTO_ONE_SHOT_TOO_FAR, AUTO_P2P_HINT } from '../../../src/automations/command';
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

const CHAT = 'oc_group';
const USER = 'ou_user';
const MATE = 'ou_mate';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const FIRE_AT = NOW + 15 * 60_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('/auto new confirm card', () => {
  it('posts a signed confirm card whose text matches the forthcoming stored item', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));

    const card = confirmCard(h);
    expect(card).toContain('提醒');
    expect(card).toContain('交周报');
    expect(card).toContain('提醒交周报');
    expect(card).toContain('Asia/Shanghai');
    expect(card).toContain('是');
    expect(card).toContain('auto.confirm');
    expect(card).toMatch(/auto_cb\.v1\./);
    expect(h.store.list()).toEqual([]);
    expect(h.store.listDrafts()).toHaveLength(1);
  });

  it('lets a second member confirm, then stores the item verbatim', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
    const card = confirmCard(h);
    expect(card).toContain('提醒交周报');
    const updatesBefore = h.channel.updatedCards.length;
    const confirmed = await h.channel.handlers.cardAction?.(
      cardClick(MATE, confirmToken(card), h.store.listDrafts()[0]!.cardMessageId!),
    );
    expect(confirmed).toEqual({ toast: { type: 'success', content: '已确认 #1' } });
    expect(h.channel.updatedCards).toHaveLength(updatesBefore);
    expect(h.store.listDrafts()).toHaveLength(0);
    await waitFor(() => settledCardUpdates(h).some((text) => text.includes('已确认 #1')));
    const settled = latestSettledCard(h);
    expect(settled).toContain('已确认 #1');
    expect(settled).not.toContain('auto.confirm');
    expect(settled).not.toContain('auto.reject');
    expect(settled).not.toContain('MATE');
    expect(settled).not.toContain(MATE);
    expect(settled).not.toContain('Op');

    expect(h.store.listDrafts()).toHaveLength(0);
    const item = h.store.list()[0];
    expect(item).toMatchObject({
      id: 1,
      taskType: 'reminder',
      name: '交周报',
      taskText: '提醒交周报',
      timezone: 'Asia/Shanghai',
      chatId: CHAT,
      createdBy: USER,
      nextFireAt: FIRE_AT,
    });
  });

  it('says so and stores nothing for stale, duplicate, or forged taps', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
    const token = confirmToken(confirmCard(h));
    const messageId = h.store.listDrafts()[0]!.cardMessageId!;

    const forged = await h.channel.handlers.cardAction?.(cardClick(USER, 'forged-token', messageId));
    expect(forged).toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
    expect(h.store.list()).toEqual([]);

    const other = await h.channel.handlers.cardAction?.(cardClick(USER, token, 'om_other'));
    expect(other).toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
    expect(h.store.list()).toEqual([]);

    await h.channel.handlers.cardAction?.(cardClick(USER, token, messageId));
    expect(h.store.list()).toHaveLength(1);
    const duplicate = await h.channel.handlers.cardAction?.(cardClick(MATE, token, messageId));
    expect(duplicate).toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
    expect(h.store.list()).toHaveLength(1);

    await h.channel.handlers.message?.(mention('om_stale', '/auto new in 20m | 过期 | 过期任务'));
    const staleToken = confirmToken(confirmCard(h));
    const staleId = h.store.listDrafts()[0]!.cardMessageId!;
    h.setNow(NOW + 24 * 60 * 60 * 1000 + 1);
    const stale = await h.channel.handlers.cardAction?.(cardClick(USER, staleToken, staleId));
    expect(stale).toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
    expect(h.store.list()).toHaveLength(1);
  });

  it('snapshots cwd when a second member confirms an agent task', async () => {
    const h = await harness({ agentTasks: true });
    await h.channel.handlers.message?.(mention('om_agent', '/auto new agent in 1h | 汇总 | 跑 issue'));
    const card = confirmCard(h);
    expect(card).toContain('agent 任务');
    expect(card).toContain('已快照工作目录');
    await h.channel.handlers.cardAction?.(
      cardClick(MATE, confirmToken(card), h.store.listDrafts()[0]!.cardMessageId!),
    );
    expect(h.store.list()[0]).toMatchObject({
      taskType: 'agent',
      name: '汇总',
      taskText: '跑 issue',
      createdBy: USER,
      cwd: h.tmp.workspace,
      nextFireAt: NOW + 60 * 60_000,
    });
  });

  it('stores nothing when the bot itself taps 是, then still accepts a human tap', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
    const token = confirmToken(confirmCard(h));
    const messageId = h.store.listDrafts()[0]!.cardMessageId!;
    const botTap = await h.channel.handlers.cardAction?.(cardClick('ou_bot', token, messageId));
    expect(botTap).toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
    expect(h.store.list()).toEqual([]);
    expect(h.store.listDrafts()).toHaveLength(1);

    await h.channel.handlers.cardAction?.(cardClick(MATE, token, messageId));
    expect(h.store.list()).toHaveLength(1);
    expect(h.store.list()[0]).toMatchObject({ createdBy: USER, name: '交周报' });
  });

  it('discards the draft when 否 is tapped', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
    const card = confirmCard(h);
    const messageId = h.store.listDrafts()[0]!.cardMessageId!;
    const updatesBefore = h.channel.updatedCards.length;
    const rejected = await h.channel.handlers.cardAction?.(cardClick(MATE, rejectToken(card), messageId, 'auto.reject'));
    expect(rejected).toEqual({ toast: { type: 'success', content: '已取消' } });
    expect(h.channel.updatedCards).toHaveLength(updatesBefore);
    expect(h.store.list()).toEqual([]);
    expect(h.store.listDrafts()).toEqual([]);
    await waitFor(() => settledCardUpdates(h).some((text) => text.includes('已取消')));
    const settled = latestSettledCard(h);
    expect(settled).toContain('已取消');
    expect(settled).not.toContain('auto.confirm');
    expect(settled).not.toContain('auto.reject');
    expect(settled).not.toContain(MATE);
  });

  it('updates the original confirm card to 已过期 after TTL and still toasts 此确认已失效', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
    const card = confirmCard(h);
    const token = confirmToken(card);
    const messageId = h.store.listDrafts()[0]!.cardMessageId!;
    h.setNow(NOW + AUTOMATIONS_DRAFT_TTL_MS + 1);
    await h.restart();
    await waitFor(() => settledCardUpdates(h).some((text) => text.includes('已过期')));
    expect(settledCardUpdates(h).filter((text) => text.includes('已过期'))).toHaveLength(1);
    const expired = await h.channel.handlers.cardAction?.(cardClick(USER, token, messageId));
    expect(expired).toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
    expect(h.store.list()).toEqual([]);
    expect(settledCardUpdates(h).filter((text) => text.includes('已过期'))).toHaveLength(1);
  });

  it('lets only one of two concurrent confirm taps succeed', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
    const token = confirmToken(confirmCard(h));
    const messageId = h.store.listDrafts()[0]!.cardMessageId!;
    const [first, second] = await Promise.all([
      h.channel.handlers.cardAction?.(cardClick(USER, token, messageId)),
      h.channel.handlers.cardAction?.(cardClick(MATE, token, messageId)),
    ]);
    const toasts = [first, second];
    expect(toasts.filter((toast) => (
      toast
      && typeof toast === 'object'
      && 'toast' in toast
      && JSON.stringify(toast) === JSON.stringify({ toast: { type: 'success', content: '已确认 #1' } })
    ))).toHaveLength(1);
    expect(toasts.filter((toast) => (
      toast
      && typeof toast === 'object'
      && JSON.stringify(toast) === JSON.stringify({ toast: { type: 'error', content: AUTO_INVALID_HINT } })
    ))).toHaveLength(1);
    expect(h.store.list()).toHaveLength(1);
    expect(h.store.listDrafts()).toEqual([]);
  });

  it('creates nothing from a bot-sent /auto new', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_bot', '/auto new in 15m | 交周报 | 提醒交周报', {
      senderId: 'ou_other_bot',
      senderType: 'app',
    }));
    expect(h.channel.sent.some((item) => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
    expect(h.store.listDrafts()).toEqual([]);
    expect(h.store.list()).toEqual([]);
  });

  it('replies 仅支持群 in p2p and rejects too-soon or too-far lead times', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_dm', '/auto new in 15m | 交周报 | 提醒交周报', {
      chatType: 'p2p',
    }));
    expect(lastMarkdown(h.channel)).toBe(AUTO_P2P_HINT);
    expect(h.store.listDrafts()).toEqual([]);

    await h.channel.handlers.message?.(mention('om_soon', '/auto new in 5m | 交周报 | 提醒交周报'));
    expect(lastMarkdown(h.channel)).toBe(AUTO_LEAD_TOO_SOON);

    await h.channel.handlers.message?.(mention('om_far', '/auto new at 2028-01-01 00:00 | 交周报 | 提醒交周报'));
    expect(lastMarkdown(h.channel)).toBe(AUTO_ONE_SHOT_TOO_FAR);
  });

  it('with a fake sender, the confirmed one-shot fires once at its instant', async () => {
    const h = await harness();
    const fires: Array<{ id: number; fireAt: number }> = [];
    await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
    await h.channel.handlers.cardAction?.(
      cardClick(MATE, confirmToken(confirmCard(h)), h.store.listDrafts()[0]!.cardMessageId!),
    );
    const item = h.store.list()[0]!;
    expect(item.nextFireAt).toBe(FIRE_AT);

    const sendDue = async () => {
      for (const current of h.store.list()) {
        if (current.nextFireAt <= 0 || h.now() < current.nextFireAt) continue;
        const key = formatFireKey(current.id, current.nextFireAt);
        if (await h.store.markStarted(key) === 'started') {
          fires.push({ id: current.id, fireAt: current.nextFireAt });
        }
      }
    };

    await sendDue();
    expect(fires).toEqual([]);
    h.setNow(FIRE_AT);
    await sendDue();
    expect(fires).toEqual([{ id: 1, fireAt: FIRE_AT }]);
    await sendDue();
    expect(fires).toEqual([{ id: 1, fireAt: FIRE_AT }]);
  });

  it('does not handle /auto new or create files when automations are disabled', async () => {
    const h = await harness({ enabled: false });
    await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
    expect(h.channel.sent.some((item) => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
    expect(h.store.listDrafts()).toEqual([]);
    await expect(access(join(h.tmp.profile, 'automations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function harness(opts: {
  enabled?: boolean;
  agentTasks?: boolean;
  chatType?: 'p2p' | 'group';
  now?: () => number;
} = {}) {
  const tmp = await createTmpProfile('auto-new-');
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  let nowMs = NOW;
  const now = opts.now ?? (() => nowMs);
  const store = new AutomationsStore({
    path: join(tmp.profile, 'automations.json'),
    logPath: join(tmp.profile, 'automations.log'),
    statusPath: join(tmp.profile, 'automations-status.json'),
    now,
  });
  await store.load();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: {
      allowedUsers: [USER, MATE],
      allowedChats: [CHAT],
    },
    preferences: {
      requireMentionInGroup: true,
      messageReply: 'text',
      messageReplyMigrated: true,
    },
  });
  cfg.automations = {
    enabled: opts.enabled ?? true,
    agentTasks: opts.agentTasks ?? false,
    timezone: 'Asia/Shanghai',
  };
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(CHAT, tmp.workspace);
  const agent = new FakeAgentAdapter({ id: 'claude' });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
    chatMode: 'group',
    botIdentity: { openId: 'ou_bot', name: 'Pin Bot' },
  });
  sdk.channel = channel;
  const start = async () => startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    automations: store,
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
      processId: 'test-auto-new',
    },
  });
  let bridge = await start();
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await store.flush().catch(() => {});
    await tmp.cleanup();
  });
  return {
    channel,
    store,
    agent,
    tmp,
    chatType: opts.chatType ?? 'group',
    setNow(next: number) {
      nowMs = next;
    },
    now: () => nowMs,
    async restart() {
      await bridge.disconnect();
      bridge = await start();
    },
  };
}

function mention(
  messageId: string,
  content: string,
  extra: {
    senderId?: string;
    chatType?: 'p2p' | 'group';
    senderType?: 'user' | 'app' | 'bot';
    senderOpenId?: string;
  } = {},
): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: extra.chatType === 'p2p' ? 'oc_dm' : CHAT,
    chatType: extra.chatType ?? 'group',
    senderId: extra.senderId ?? extra.senderOpenId ?? USER,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime: NOW,
    raw: extra.senderType
      ? { sender: { sender_type: extra.senderType, sender_id: { open_id: extra.senderId ?? USER } } }
      : { sender: { sender_type: 'user', sender_id: { open_id: extra.senderId ?? USER } } },
  } as unknown as NormalizedMessage;
}

function confirmCard(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string {
  const send = [...h.channel.sent].reverse().find((item) => JSON.stringify(item.content).includes('auto.confirm'));
  expect(send, 'expected a confirm card in chat').toBeDefined();
  return JSON.stringify(send?.content);
}

function confirmToken(cardJson: string): string {
  const match = cardJson.match(/"cmd":"auto.confirm","auto_token":"(auto_cb\.v1\.[^"]+)"/);
  expect(match?.[1], 'expected auto.confirm token').toBeDefined();
  return match![1]!;
}

function rejectToken(cardJson: string): string {
  const match = cardJson.match(/"cmd":"auto.reject","auto_token":"(auto_cb\.v1\.[^"]+)"/);
  expect(match?.[1], 'expected auto.reject token').toBeDefined();
  return match![1]!;
}

function cardClick(
  operatorId: string,
  token: string,
  messageId: string,
  cmd: 'auto.confirm' | 'auto.reject' = 'auto.confirm',
): CardActionEvent {
  return {
    action: { value: { cmd, auto_token: token } },
    chatId: CHAT,
    messageId,
    operator: { openId: operatorId, name: 'Op' },
  } as unknown as CardActionEvent;
}

function lastMarkdown(channel: ReturnType<typeof createRecordingLarkChannel>): string {
  const send = [...channel.sent].reverse().find((item) => {
    const content = item.content as { markdown?: unknown };
    return typeof content?.markdown === 'string';
  });
  expect(send, 'expected a markdown reply').toBeDefined();
  return (send!.content as { markdown: string }).markdown;
}

function settledCardUpdates(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string[] {
  return h.channel.updatedCards
    .map((item) => JSON.stringify(item.card))
    .filter((text) => text.includes('已确认 #') || text.includes('已取消') || text.includes('已过期'));
}

function latestSettledCard(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string {
  const text = [...settledCardUpdates(h)].at(-1);
  expect(text, 'expected a settled one-shot card update').toBeDefined();
  return text!;
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
