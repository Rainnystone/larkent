import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
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
const FIRE_AT = NOW + 10 * 60_000;
const VISIBLE = '好的，10 分钟后提醒你交周报。';
const CARD_INSTANT = '2026-10-17 11:10';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('A6 natural-language creation', () => {
  it('strips the proposal from the outbox reply, posts a confirm card whose absolute instant matches the draft, and leaves status/log clean', async () => {
    const h = await harness({
      events: [
        { type: 'text', delta: `${VISIBLE}\n${proposalXml({
          taskType: 'reminder',
          schedule: '10 分钟后',
          name: '交周报',
          taskText: '提醒我交周报',
          chatId: 'oc_spoof',
          createdBy: 'ou_spoof',
          scope: 'auto:9:1',
        })}` },
        { type: 'done', terminationReason: 'normal' },
      ],
    });

    await h.channel.handlers.message?.(mention('om_nl', '10 分钟后提醒我交周报'));
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes('auto.confirm')));

    const answers = markdownSends(h).filter((text) => text.includes(VISIBLE));
    expect(answers).toHaveLength(1);
    expect(answers[0]).toContain(VISIBLE);
    expect(answers[0]).not.toContain('automation_proposal');
    expect(answers[0]).not.toContain('oc_spoof');
    expect(answers[0]).not.toContain('ou_spoof');
    expect(answers[0]).not.toContain('auto:9:1');

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('plugins.inspect');
    expect(prompt).not.toContain('automation_proposal');
    expect(prompt).toContain('10 分钟后提醒我交周报');

    const card = confirmCard(h);
    expect(card).toContain('交周报');
    expect(card).toContain('提醒我交周报');
    expect(card).toContain(CARD_INSTANT);
    expect(card).toContain('Asia/Shanghai');

    const draft = h.store.listDrafts()[0];
    expect(draft).toMatchObject({
      taskType: 'reminder',
      name: '交周报',
      taskText: '提醒我交周报',
      timezone: 'Asia/Shanghai',
      chatId: CHAT,
      createdBy: USER,
      nextFireAt: FIRE_AT,
    });
    expect(draft && 'nextFireAt' in draft ? draft.nextFireAt : undefined).toBe(FIRE_AT);

    const turn = h.journal.list().find((entry) => entry.messageIds.includes('om_nl'));
    expect(turn?.reply?.markdown).toContain(VISIBLE);
    expect(turn?.reply?.markdown).not.toContain('automation_proposal');
    expect(turn?.reply?.state === 'sent' || turn?.reply?.messageId).toBeTruthy();
    expect(h.journal.list().filter((entry) => entry.reply?.markdown?.includes(VISIBLE))).toHaveLength(1);

    expect(await h.store.readLog()).toEqual([]);
    await expectStatusClean(h.statusPath, ['提醒我交周报', USER, CHAT, 'oc_spoof']);

    await h.channel.handlers.cardAction?.(
      cardClick(MATE, confirmToken(card), draft!.cardMessageId!),
    );
    expect(h.store.list()[0]).toMatchObject({
      id: 1,
      taskType: 'reminder',
      name: '交周报',
      taskText: '提醒我交周报',
      chatId: CHAT,
      createdBy: USER,
      nextFireAt: FIRE_AT,
    });
    expect(await h.store.readLog()).toEqual([]);
    await expectStatusClean(h.statusPath, ['提醒我交周报', USER, 'oc_spoof']);
  }, 15_000);

  it('creates nothing from a proposal in a bot-sent mention', async () => {
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

  it('strips the proposal from the live markdown stream on the default reply path', async () => {
    const h = await harness({
      replyMode: 'markdown',
      events: [
        { type: 'text', delta: `${VISIBLE}\n${proposalXml({
          taskType: 'reminder',
          schedule: '10 分钟后',
          name: '交周报',
          taskText: '提醒我交周报',
          chatId: 'oc_spoof',
        })}` },
        { type: 'done', terminationReason: 'normal' },
      ],
    });

    await h.channel.handlers.message?.(mention('om_md', '10 分钟后提醒我交周报'));
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes('auto.confirm')));

    const streamed = h.channel.streams.flatMap((stream) => stream.markdownContents);
    expect(streamed.some((text) => text.includes(VISIBLE))).toBe(true);
    for (const text of streamed) {
      expect(text).not.toContain('automation_proposal');
      expect(text).not.toContain('oc_spoof');
    }
    const turn = h.journal.list().find((entry) => entry.messageIds.includes('om_md'));
    expect(turn?.reply?.markdown).toContain(VISIBLE);
    expect(turn?.reply?.markdown).not.toContain('automation_proposal');
    expect(h.store.listDrafts()[0]).toMatchObject({
      chatId: CHAT,
      createdBy: USER,
      nextFireAt: FIRE_AT,
    });
    expect(await h.store.readLog()).toEqual([]);
    await expectStatusClean(h.statusPath, ['提醒我交周报', USER, CHAT, 'oc_spoof']);
  }, 15_000);

  it('creates a draft from Codex finalText without leaking the tag on the dedicated reply', async () => {
    const h = await harness({
      replyMode: 'markdown',
      agentKind: 'codex',
      events: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'true' } },
        { type: 'tool_result', id: 't1', output: 'ok', isError: false },
        { type: 'final_text', content: `${VISIBLE}\n${proposalXml({
          taskType: 'reminder',
          schedule: '10 分钟后',
          name: '交周报',
          taskText: '提醒我交周报',
        })}` },
        { type: 'done', terminationReason: 'normal' },
      ],
    });

    await h.channel.handlers.message?.(mention('om_codex', '10 分钟后提醒我交周报'));
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes('auto.confirm')));

    const shown = [
      ...markdownSends(h),
      ...h.channel.streams.flatMap((stream) => stream.markdownContents),
    ];
    expect(shown.some((text) => text.includes(VISIBLE))).toBe(true);
    for (const text of shown) {
      expect(text).not.toContain('automation_proposal');
    }
    expect(h.store.listDrafts()[0]).toMatchObject({
      name: '交周报',
      chatId: CHAT,
      createdBy: USER,
      nextFireAt: FIRE_AT,
    });
    expect(await h.store.readLog()).toEqual([]);
    await expectStatusClean(h.statusPath, ['提醒我交周报', USER, 'oc_spoof']);
  }, 15_000);

  it('defers the confirm card while the link is down and posts it after reconnect', async () => {
    const h = await harness({
      linkDown: true,
      events: [
        { type: 'text', delta: `${VISIBLE}\n${proposalXml({
          taskType: 'reminder',
          schedule: '10 分钟后',
          name: '交周报',
          taskText: '提醒我交周报',
        })}` },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await h.channel.handlers.message?.(mention('om_nl', '10 分钟后提醒我交周报'));
    await waitFor(() => h.store.listDrafts().length === 1);
    expect(h.channel.sent.some((item) => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
    expect(markdownSends(h).some((text) => text.includes(VISIBLE))).toBe(false);
    expect(h.store.listDrafts()[0]?.cardMessageId).toBeUndefined();

    h.channel.connectionState = 'connected';
    await h.bridge.tickLink();
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes('auto.confirm')));
    const draft = h.store.listDrafts()[0];
    expect(draft?.cardMessageId).toBeTypeOf('string');
    expect(confirmCard(h)).toContain('交周报');
  }, 15_000);

  it('asks for an end on a weekday proposal before any confirm card', async () => {
    const h = await harness({
      events: [{
        type: 'text',
        delta: `好的。\n${proposalXml({
          taskType: 'reminder',
          schedule: '每个工作日 09:00',
          name: '站会',
          taskText: '提醒站会',
        })}`,
      }, { type: 'done', terminationReason: 'normal' }],
    });
    await h.channel.handlers.message?.(mention('om_week', '每个工作日 9 点提醒站会'));
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes('auto.end.')));
    const endCard = JSON.stringify(h.channel.sent.find((item) => JSON.stringify(item.content).includes('auto.end.'))?.content);
    expect(endCard).toContain('end_at');
    expect(endCard).not.toContain('auto.confirm');
    expect(h.store.list()).toEqual([]);
    expect(h.store.listDrafts()).toHaveLength(1);
    expect(h.store.listDrafts()[0]).toMatchObject({
      name: '站会',
      createdBy: USER,
      chatId: CHAT,
    });
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

function cardClick(
  operatorId: string,
  token: string,
  messageId: string,
): CardActionEvent {
  return {
    action: { value: { cmd: 'auto.confirm', auto_token: token } },
    chatId: CHAT,
    messageId,
    operator: { openId: operatorId, name: 'Op' },
  } as unknown as CardActionEvent;
}

function markdownSends(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string[] {
  return h.channel.sent.flatMap((item) => {
    const content = item.content as { markdown?: unknown };
    return typeof content?.markdown === 'string' ? [content.markdown] : [];
  });
}

async function expectStatusClean(statusPath: string, forbidden: string[]): Promise<void> {
  try {
    const raw = await readFile(statusPath, 'utf8');
    for (const token of forbidden) {
      expect(raw, `status block must not contain ${token}`).not.toContain(token);
    }
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (Array.isArray(parsed.items) && parsed.items.length > 0) {
      expect(JSON.stringify(parsed.items)).not.toMatch(/taskText|createdBy|chatId/);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
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
