import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTO_P2P_HINT } from '../../../src/automations/command';
import { AutomationsStore } from '../../../src/automations/store';
import { log } from '../../../src/core/logger';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { axiosHttpError, axiosLike, sdkShapedSendError } from '../../helpers/sdk-feishu-errors';
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
const OTHER = 'oc_other';
const USER = 'ou_user';
const MATE = 'ou_mate';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const FIRE_AT = NOW + 15 * 60_000;
const TASK_BODY = '提醒交周报';

const cleanups: Array<() => Promise<void>> = [];
const info = vi.spyOn(log, 'info');

afterEach(async () => {
  info.mockClear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('automation lifecycle and observability', () => {
  it('bot-removed event deletes that group’s tasks, stops writing its board, and logs auto.removed-from-chat without task text', async () => {
    const h = await harness();
    await confirmOne(h, CHAT, 'om_new');
    await h.store.create({
      taskType: 'reminder',
      schedule: { kind: 'one-shot', at: FIRE_AT + 7 * 24 * 60_000, timezone: 'Asia/Shanghai' },
      timezone: 'Asia/Shanghai',
      startAt: NOW,
      nextFireAt: FIRE_AT + 7 * 24 * 60_000,
      chatId: OTHER,
      createdBy: USER,
      name: '别群',
      taskText: 'secret other body',
    });
    await h.restart();

    const leftBoard = boardForChat(h, CHAT);
    const chatBoardSends = () => h.channel.sent.filter((item) =>
      item.chatId === CHAT && isBoardContent(item.content),
    ).length;
    const chatBoardUpdates = () => h.channel.updatedCards.filter((item) =>
      item.messageId === leftBoard.messageId,
    ).length;
    const sendsBefore = chatBoardSends();
    const updatesBefore = chatBoardUpdates();
    expect(leftBoard.text).toContain('#1');
    expect(statusBlock(leftBoard.text).items.map((item) => item.id)).toEqual([1]);
    expect(h.store.list().map((item) => item.chatId).sort()).toEqual([CHAT, OTHER]);

    h.channel.emitRaw('im.chat.member.bot.deleted_v1', { chat_id: CHAT });
    const status = await waitForStatus(h, (snapshot) =>
      h.store.list().every((item) => item.chatId !== CHAT)
      && snapshot.items.map((item) => item.id).join() === '2',
    );

    expect(h.store.list().map((item) => item.chatId)).toEqual([OTHER]);
    expect(h.store.getBoard(CHAT)).toBeUndefined();
    expect(h.store.listDrafts().filter((draft) => draft.chatId === CHAT)).toEqual([]);

    expect(chatBoardSends()).toBe(sendsBefore);
    expect(chatBoardUpdates()).toBe(updatesBefore);

    expect(status.v).toBe(1);
    expect(status.items.map((item) => item.id)).toEqual([2]);
    expect(JSON.stringify(status)).not.toContain(TASK_BODY);
    expect(JSON.stringify(status)).not.toContain('secret other body');

    const otherBoard = boardForChat(h, OTHER);
    expect(statusBlock(otherBoard.text).items.map((item) => item.id)).toEqual([2]);
    expect(JSON.stringify(otherBoard.text)).not.toContain(TASK_BODY);

    const removed = autoEvents().filter((entry) => entry.event === 'removed-from-chat');
    expect(removed).toEqual([
      expect.objectContaining({
        event: 'removed-from-chat',
        fields: expect.objectContaining({ chatId: CHAT }),
      }),
    ]);
    expect(JSON.stringify(autoEvents())).not.toContain(TASK_BODY);
    expect(JSON.stringify(autoEvents())).not.toContain('secret other body');

    await expect(readFile(h.logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    h.setNow(FIRE_AT + 1);
    await h.restart();
    expect(h.store.list().map((item) => item.id)).toEqual([2]);
    await expect(readFile(h.logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(autoEvents().filter((entry) =>
      (entry.event === 'catch-up' || entry.event === 'fire') && entry.fields.id === 1,
    )).toEqual([]);
  });

  it('chat-disbanded event deletes that group’s tasks and does not write the board', async () => {
    const h = await harness();
    await confirmOne(h, CHAT, 'om_new');
    const leftBoard = boardForChat(h, CHAT);
    const updatesBefore = h.channel.updatedCards.filter((item) => item.messageId === leftBoard.messageId).length;

    h.channel.emitRaw('im.chat.disbanded_v1', { event: { chat_id: CHAT } });
    const status = await waitForStatus(h, (snapshot) =>
      h.store.list().length === 0 && snapshot.items.length === 0,
    );

    expect(h.store.getBoard(CHAT)).toBeUndefined();
    expect(h.channel.updatedCards.filter((item) => item.messageId === leftBoard.messageId)).toHaveLength(updatesBefore);
    expect(status.items).toEqual([]);
    expect(autoEvents().filter((entry) => entry.event === 'removed-from-chat')).toHaveLength(1);
    expect(JSON.stringify(autoEvents())).not.toContain(TASK_BODY);
    await expect(readFile(h.logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a 230002 or 232009 send deletes that group; a gone-card 404 does not', async () => {
    const gone = await harness();
    await confirmOne(gone, CHAT, 'om_new');
    const first = boardForChat(gone, CHAT);
    gone.channel.cardErrors.update = axiosHttpError(404, 'card gone');
    await gone.channel.handlers.cardAction?.(
      boardClick(USER, pauseToken(first.text), first.messageId, 'auto.pause'),
    );
    expect(gone.store.get(1)?.paused).toBe(true);
    expect(gone.store.list()).toHaveLength(1);
    const replaced = boardForChat(gone, CHAT);
    expect(replaced.messageId).not.toBe(first.messageId);
    expect(statusBlock(replaced.text).items[0]?.paused).toBe(true);

    for (const code of [230002, 232009] as const) {
      const h = await harness();
      await confirmOne(h, CHAT, 'om_new');
      const board = boardForChat(h, CHAT);
      const sendsBefore = h.channel.sent.filter((item) =>
        item.chatId === CHAT && isBoardContent(item.content),
      ).length;
      h.channel.cardErrors.update = notInChatError(code);
      await h.channel.handlers.cardAction?.(
        boardClick(USER, pauseToken(board.text), board.messageId, 'auto.pause'),
      );
      const status = await waitForStatus(h, (snapshot) =>
        h.store.list().length === 0 && snapshot.items.length === 0,
      );
      expect(h.store.getBoard(CHAT)).toBeUndefined();
      expect(h.channel.sent.filter((item) =>
        item.chatId === CHAT && isBoardContent(item.content),
      )).toHaveLength(sendsBefore);
      expect(status.items).toEqual([]);
      expect(autoEvents().filter((entry) =>
        entry.event === 'removed-from-chat' && entry.fields.chatId === CHAT,
      ).length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(autoEvents())).not.toContain(TASK_BODY);
    }
  });

  it('a /auto reply rejected as not-in-chat deletes that group’s tasks', async () => {
    const h = await harness();
    await confirmOne(h, CHAT, 'om_new');
    h.channel.sendErrors.send = notInChatError(230002);
    await h.channel.handlers.message?.(mention('om_list', '/auto'));
    await waitForStatus(h, (snapshot) =>
      h.store.list().length === 0 && snapshot.items.length === 0,
    );
    expect(h.store.getBoard(CHAT)).toBeUndefined();
    expect(autoEvents().some((entry) => entry.event === 'removed-from-chat')).toBe(true);
    expect(JSON.stringify(autoEvents())).not.toContain(TASK_BODY);
  });

  it('replies 仅支持群 in p2p and emits lifecycle events without task text', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_dm', '/auto', { chatType: 'p2p' }));
    expect(lastMarkdown(h.channel)).toBe(AUTO_P2P_HINT);
    expect(autoEvents().some((entry) => entry.event === 'draft')).toBe(false);

    await h.channel.handlers.message?.(mention('om_reject', '/auto new in 15m | 交周报 | 提醒交周报'));
    const rejectCard = confirmCard(h);
    await h.channel.handlers.cardAction?.(
      cardClick(USER, rejectToken(rejectCard), h.store.listDrafts()[0]!.cardMessageId!, CHAT, 'auto.reject'),
    );
    expect(h.store.listDrafts()).toEqual([]);
    expect(autoEvents().some((entry) => entry.event === 'draft')).toBe(true);
    expect(autoEvents().some((entry) => entry.event === 'rejected')).toBe(true);

    await confirmOne(h, CHAT, 'om_new');
    const board = boardForChat(h, CHAT);
    await h.channel.handlers.cardAction?.(
      boardClick(USER, pauseToken(board.text), board.messageId, 'auto.pause'),
    );
    await h.channel.handlers.cardAction?.(
      boardClick(USER, resumeToken(boardForChat(h, CHAT).text), board.messageId, 'auto.resume'),
    );
    await h.channel.handlers.cardAction?.(
      boardClick(USER, deleteToken(boardForChat(h, CHAT).text), board.messageId, 'auto.delete'),
    );
    expect(h.store.list()).toEqual([]);

    const events = autoEvents().map((entry) => entry.event);
    expect(events).toEqual(expect.arrayContaining([
      'draft',
      'confirmed',
      'rejected',
      'paused',
      'deleted',
    ]));
    expect(JSON.stringify(autoEvents())).not.toContain(TASK_BODY);
    expect(JSON.stringify(autoEvents())).not.toContain('提醒交周报');
  });
});

async function harness() {
  const tmp = await createTmpProfile('auto-lifecycle-');
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  let nowMs = NOW;
  const now = () => nowMs;
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
      allowedChats: [CHAT, OTHER],
    },
    preferences: {
      requireMentionInGroup: true,
      messageReply: 'text',
      messageReplyMigrated: true,
    },
  });
  cfg.automations = {
    enabled: true,
    agentTasks: false,
    timezone: 'Asia/Shanghai',
  };
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(CHAT, tmp.workspace);
  workspaces.setCwd(OTHER, tmp.workspace);
  const agent = new FakeAgentAdapter({ id: 'claude' });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }, { id: OTHER, name: 'H' }],
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
      processId: 'test-auto-lifecycle',
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
    statusPath: join(tmp.profile, 'automations-status.json'),
    logPath: join(tmp.profile, 'automations.log'),
    get bridge() {
      return bridge;
    },
    now,
    setNow(next: number) {
      nowMs = next;
    },
    async restart() {
      await bridge.disconnect();
      bridge = await start();
    },
  };
}

async function confirmOne(
  h: Awaited<ReturnType<typeof harness>>,
  chatId: string,
  messageId: string,
): Promise<void> {
  await h.channel.handlers.message?.(mention(messageId, '/auto new in 15m | 交周报 | 提醒交周报', { chatId }));
  const card = confirmCard(h);
  await h.channel.handlers.cardAction?.(
    cardClick(USER, confirmToken(card), h.store.listDrafts()[0]!.cardMessageId!, chatId),
  );
}

function mention(
  messageId: string,
  content: string,
  extra: { chatId?: string; chatType?: 'p2p' | 'group' } = {},
): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: extra.chatType === 'p2p' ? 'oc_dm' : (extra.chatId ?? CHAT),
    chatType: extra.chatType ?? 'group',
    senderId: USER,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime: NOW,
    raw: { sender: { sender_type: 'user', sender_id: { open_id: USER } } },
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
  chatId = CHAT,
  cmd: 'auto.confirm' | 'auto.reject' = 'auto.confirm',
): CardActionEvent {
  return {
    action: { value: { cmd, auto_token: token } },
    chatId,
    messageId,
    operator: { openId: operatorId, name: 'Op' },
  } as unknown as CardActionEvent;
}

function boardClick(
  operatorId: string,
  token: string,
  messageId: string,
  cmd: 'auto.pause' | 'auto.resume' | 'auto.delete',
): CardActionEvent {
  return {
    action: { value: { cmd, auto_token: token } },
    chatId: CHAT,
    messageId,
    operator: { openId: operatorId, name: 'Op' },
  } as unknown as CardActionEvent;
}

function rejectToken(cardJson: string): string {
  const match = cardJson.match(/"cmd":"auto.reject","auto_token":"(auto_cb\.v1\.[^"]+)"/);
  expect(match?.[1], 'expected auto.reject token').toBeDefined();
  return match![1]!;
}

function pauseToken(cardJson: string): string {
  const match = cardJson.match(/"cmd":"auto.pause","auto_token":"(auto_board\.v1\.[^"]+)"/);
  expect(match?.[1], 'expected auto.pause token').toBeDefined();
  return match![1]!;
}

function resumeToken(cardJson: string): string {
  const match = cardJson.match(/"cmd":"auto.resume","auto_token":"(auto_board\.v1\.[^"]+)"/);
  expect(match?.[1], 'expected auto.resume token').toBeDefined();
  return match![1]!;
}

function deleteToken(cardJson: string): string {
  const match = cardJson.match(/"cmd":"auto.delete","auto_token":"(auto_board\.v1\.[^"]+)"/);
  expect(match?.[1], 'expected auto.delete token').toBeDefined();
  return match![1]!;
}

function notInChatError(code: 230002 | 232009) {
  return sdkShapedSendError('format_error', axiosLike('The bot can not be outside the group', {
    response: { status: 400, data: { code } },
  }));
}

function lastMarkdown(channel: ReturnType<typeof createRecordingLarkChannel>): string {
  const send = [...channel.sent].reverse().find((item) => {
    const content = item.content as { markdown?: unknown };
    return typeof content?.markdown === 'string';
  });
  expect(send, 'expected a markdown reply').toBeDefined();
  return (send!.content as { markdown: string }).markdown;
}

function isBoardContent(content: unknown): boolean {
  return JSON.stringify(content).includes('本群自动化');
}

function boardForChat(
  h: { channel: ReturnType<typeof createRecordingLarkChannel> },
  chatId: string,
): { messageId: string; text: string } {
  const updated = [...h.channel.updatedCards].reverse().find((item) => {
    if (!isBoardContent(item.card)) return false;
    const send = [...h.channel.sent].reverse().find((entry) =>
      entry.chatId === chatId && isBoardContent(entry.content),
    );
    return send !== undefined && (
      h.channel.pins.some((pin) => pin.messageId === item.messageId && pin.chatId === chatId)
      || JSON.stringify(item.card) === JSON.stringify((send.content as { card?: unknown }).card ?? send.content)
    );
  });
  const send = [...h.channel.sent].reverse().find((item) =>
    item.chatId === chatId && isBoardContent(item.content),
  );
  expect(send, `expected a board card in ${chatId}`).toBeDefined();
  const content = send!.content as { card?: unknown };
  return {
    messageId: h.channel.pins.find((pin) => pin.chatId === chatId)?.messageId
      ?? updated?.messageId
      ?? `om_unknown_${chatId}`,
    text: JSON.stringify(updated?.card ?? content.card ?? send!.content),
  };
}

function statusBlock(cardJson: string): {
  v: number;
  items: Array<{ id: number; paused: boolean }>;
} {
  const escaped = cardJson.indexOf('{\\"v\\":1');
  const source = escaped >= 0 ? cardJson.slice(escaped).replace(/\\"/g, '"') : cardJson;
  const match = source.match(/\{"v":1,[\s\S]*?"items":\[[^\]]*\]\}/);
  expect(match?.[0], 'expected a status block v1 JSON note').toBeDefined();
  return JSON.parse(match![0]!) as ReturnType<typeof statusBlock>;
}

function autoEvents(): Array<{ event: string; fields: Record<string, unknown> }> {
  return info.mock.calls
    .filter((call) => call[0] === 'auto')
    .map((call) => ({
      event: String(call[1]),
      fields: (call[2] ?? {}) as Record<string, unknown>,
    }));
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForStatus(
  h: { statusPath: string },
  pred: (status: { v: number; items: Array<{ id: number }> }) => boolean | Promise<boolean>,
): Promise<{ v: number; items: Array<{ id: number }> }> {
  let snapshot: { v: number; items: Array<{ id: number }> } | undefined;
  await waitFor(async () => {
    try {
      snapshot = JSON.parse(await readFile(h.statusPath, 'utf8')) as {
        v: number;
        items: Array<{ id: number }>;
      };
      return pred(snapshot);
    } catch {
      return false;
    }
  });
  expect(snapshot, 'expected automations-status.json after leave').toBeDefined();
  return snapshot!;
}
