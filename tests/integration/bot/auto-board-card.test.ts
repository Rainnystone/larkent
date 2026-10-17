import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATCH_UP_WINDOW_MS } from '../../../src/automations/schedule';
import { AutomationsStore } from '../../../src/automations/store';
import { AUTO_INVALID_HINT, AUTO_P2P_HINT } from '../../../src/automations/command';
import { FEISHU_LINK_SILENT_PROBE_MS, FEISHU_LINK_TICK_MS } from '../../../src/bot/feishu-link';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { axiosHttpError } from '../../helpers/sdk-feishu-errors';
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
const HOUR = 60 * 60_000;
const T0 = Date.UTC(2026, 0, 2, 12, 0, 0);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('automation board card', () => {
  it('posts a pinned board whose status block matches the A0c snapshot after confirm, and pause updates it in place', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
    const confirm = confirmCard(h);
    await h.channel.handlers.cardAction?.(
      cardClick(MATE, confirmToken(confirm), h.store.listDrafts()[0]!.cardMessageId!),
    );

    const board = latestBoard(h);
    expect(board.text).toContain('#1');
    expect(board.text).toContain('交周报');
    expect(board.text).toContain('提醒');
    expect(board.text).toContain('暂停');
    expect(board.text).toContain('删除');
    expect(board.text).not.toContain('提醒交周报');
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([board.messageId]);

    const block = statusBlock(board.text);
    expect(block.v).toBe(1);
    expect(block.bot).toBe('Pin Bot');
    expect(block.items).toEqual([
      expect.objectContaining({
        id: 1,
        paused: false,
        nextFireAt: FIRE_AT,
        lastFireAt: 0,
        lastStatus: 'ok',
        missed: 0,
      }),
    ]);
    expect(JSON.stringify(block)).not.toMatch(/\b(oc|om|ou|on)_[A-Za-z0-9]+/);
    expect(JSON.stringify(block)).not.toContain('提醒交周报');
    expect(JSON.stringify(block)).not.toContain(USER);

    const status = JSON.parse(await readFile(h.statusPath, 'utf8')) as typeof block;
    expect(status.v).toBe(1);
    expect(status.items[0]).toMatchObject({ id: 1, paused: false, nextFireAt: FIRE_AT });
    expect(status.updatedAt).toBe(block.updatedAt);
    await expect(readFile(h.logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const sendsBeforePause = h.channel.sent.filter((item) => isBoardContent(item.content)).length;
    const originalPause = pauseToken(board.text);
    h.setNow(h.now() + 1);
    await h.channel.handlers.cardAction?.(
      boardClick(USER, originalPause, board.messageId, 'auto.pause'),
    );

    const paused = latestBoard(h);
    expect(paused.messageId).toBe(board.messageId);
    expect(h.channel.sent.filter((item) => isBoardContent(item.content))).toHaveLength(sendsBeforePause);
    expect(statusBlock(paused.text).items[0]?.paused).toBe(true);
    expect(statusBlock(paused.text).updatedAt).toBeGreaterThan(block.updatedAt);
    expect(h.store.get(1)?.paused).toBe(true);
    expect(JSON.parse(await readFile(h.statusPath, 'utf8')).items[0].paused).toBe(true);

    await h.channel.handlers.cardAction?.(
      boardClick(MATE, originalPause, paused.messageId, 'auto.pause'),
    );
    expect(h.store.get(1)?.paused).toBe(true);

    await h.channel.handlers.cardAction?.(
      boardClick(USER, 'forged-board-token', paused.messageId, 'auto.pause'),
    );
    expect(lastMarkdown(h.channel)).toBe(AUTO_INVALID_HINT);
    expect(h.store.get(1)?.paused).toBe(true);
  });

  it('lists missed instants as 已错过 rows from the A0c snapshot, keeps the log, and drops the rows after 24 h', async () => {
    const h = await harness({ nowMs: T0 + 2 * HOUR + 1 });
    await h.store.create({
      taskType: 'reminder',
      schedule: {
        kind: 'interval',
        timezone: 'UTC',
        everyMs: HOUR,
        startAt: T0,
        endAt: T0 + 365 * 24 * HOUR,
      },
      timezone: 'UTC',
      startAt: T0,
      endAt: T0 + 365 * 24 * HOUR,
      nextFireAt: T0,
      chatId: CHAT,
      createdBy: USER,
      name: 'hourly ping',
      taskText: 'secret ping body',
    });
    await h.restart();

    const board = latestBoard(h);
    expect(board.text).toContain('已错过 原定 2026-01-02 12:00');
    expect(board.text).toContain('已错过 原定 2026-01-02 13:00');
    expect(board.text).not.toContain('secret ping body');
    const block = statusBlock(board.text);
    expect(block.v).toBe(1);
    expect(block.items[0]).toMatchObject({ id: 1, missed: 2 });
    expect(JSON.stringify(block)).not.toContain('secret ping body');
    expect(JSON.stringify(block)).not.toContain(USER);

    const status = JSON.parse(await readFile(h.statusPath, 'utf8')) as typeof block;
    expect(status.items[0]?.missed).toBe(2);
    const logEntries = (await readFile(h.logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { result: string; scheduledAt: number });
    expect(logEntries.filter((entry) => entry.result === 'missed').map((entry) => entry.scheduledAt)).toEqual([
      T0,
      T0 + HOUR,
    ]);
    expect(logEntries.filter((entry) => entry.result === 'catch-up')).toHaveLength(1);

    h.setNow(T0 + 2 * HOUR + 1 + CATCH_UP_WINDOW_MS + 1);
    await h.channel.handlers.cardAction?.(
      boardClick(USER, pauseToken(board.text), board.messageId, 'auto.pause'),
    );
    const after = latestBoard(h);
    expect(after.text).not.toContain('已错过 原定 2026-01-02 12:00');
    expect(after.text).not.toContain('已错过 原定 2026-01-02 13:00');
    expect(await readFile(h.logPath, 'utf8')).toContain('"result":"missed"');
  });

  it('re-pins the same board when it is missing from the pin list and leaves tasks in place', async () => {
    const h = await harness();
    await confirmOne(h);
    const board = latestBoard(h);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([board.messageId]);
    h.channel.dropPins();
    expect(h.channel.pins).toEqual([]);
    await h.channel.handlers.cardAction?.(
      boardClick(MATE, pauseToken(board.text), board.messageId, 'auto.pause'),
    );
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([board.messageId]);
    expect(h.store.list()).toHaveLength(1);
    expect(latestBoard(h).messageId).toBe(board.messageId);
  });

  it('does not post a second board on restart and re-renders on link recovery', async () => {
    const h = await harness();
    await confirmOne(h);
    const first = latestBoard(h);
    const boardSends = () => h.channel.sent.filter((item) => isBoardContent(item.content)).length;
    expect(boardSends()).toBe(1);

    await h.restart();
    expect(latestBoard(h).messageId).toBe(first.messageId);
    expect(boardSends()).toBe(1);

    h.probeOk = false;
    const downUntil = h.now() + FEISHU_LINK_SILENT_PROBE_MS + 3 * FEISHU_LINK_TICK_MS;
    while (h.now() < downUntil) {
      h.setNow(h.now() + FEISHU_LINK_TICK_MS);
      await h.bridge.tickLink();
    }
    const updatesBefore = h.channel.updatedCards.length;
    h.probeOk = true;
    h.setNow(h.now() + FEISHU_LINK_TICK_MS);
    await h.bridge.tickLink();
    await waitFor(() => h.channel.updatedCards.length > updatesBefore);
    expect(latestBoard(h).messageId).toBe(first.messageId);
    expect(boardSends()).toBe(1);
    expect(statusBlock(latestBoard(h).text).v).toBe(1);
  });

  it('lists and mutates tasks through /auto fallback commands', async () => {
    const h = await harness();
    await confirmOne(h);
    await h.channel.handlers.message?.(mention('om_list', '/auto'));
    expect(lastMarkdown(h.channel)).toContain('#1 交周报');
    expect(lastMarkdown(h.channel)).toContain('提醒');

    await h.channel.handlers.message?.(mention('om_pause', '/auto pause 1'));
    expect(h.store.get(1)?.paused).toBe(true);
    expect(statusBlock(latestBoard(h).text).items[0]?.paused).toBe(true);

    await h.channel.handlers.message?.(mention('om_resume', '/auto resume 1'));
    expect(h.store.get(1)?.paused).toBe(false);

    await h.channel.handlers.message?.(mention('om_delete', '/auto delete 1'));
    expect(h.store.list()).toEqual([]);
    expect(latestBoard(h).text).toContain('暂无');
    expect(h.channel.pins).toEqual([]);
  });

  it('re-sends and pins a replacement board when the card cannot be patched', async () => {
    const h = await harness();
    await confirmOne(h);
    const first = latestBoard(h);
    h.channel.cardErrors.update = axiosHttpError(404, 'card gone');
    await h.channel.handlers.cardAction?.(
      boardClick(USER, pauseToken(first.text), first.messageId, 'auto.pause'),
    );
    const next = latestBoard(h);
    expect(next.messageId).not.toBe(first.messageId);
    expect(statusBlock(next.text).items[0]?.paused).toBe(true);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([next.messageId]);
  });

  it('rejects p2p /auto and does not create a board when automations are off', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_dm', '/auto', { chatType: 'p2p' }));
    expect(lastMarkdown(h.channel)).toBe(AUTO_P2P_HINT);

    const off = await harness({ enabled: false });
    await off.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
    expect(off.channel.sent.some((item) => isBoardContent(item.content))).toBe(false);
    expect(off.store.list()).toEqual([]);
  });
});

async function harness(opts: { enabled?: boolean; nowMs?: number } = {}) {
  const tmp = await createTmpProfile('auto-board-');
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  let nowMs = opts.nowMs ?? NOW;
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
    agentTasks: false,
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
  let probeOk = true;
  const start = async () => startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    automations: store,
    now,
    probe: async () => probeOk,
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
      processId: 'test-auto-board',
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
    tmp,
    statusPath: join(tmp.profile, 'automations-status.json'),
    logPath: join(tmp.profile, 'automations.log'),
    get bridge() {
      return bridge;
    },
    get probeOk() {
      return probeOk;
    },
    set probeOk(next: boolean) {
      probeOk = next;
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

async function confirmOne(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
  const card = confirmCard(h);
  await h.channel.handlers.cardAction?.(
    cardClick(USER, confirmToken(card), h.store.listDrafts()[0]!.cardMessageId!),
  );
}

function mention(
  messageId: string,
  content: string,
  extra: { chatType?: 'p2p' | 'group' } = {},
): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: extra.chatType === 'p2p' ? 'oc_dm' : CHAT,
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

function pauseToken(cardJson: string): string {
  const match = cardJson.match(/"cmd":"auto.pause","auto_token":"(auto_board\.v1\.[^"]+)"/);
  expect(match?.[1], 'expected auto.pause token').toBeDefined();
  return match![1]!;
}

function cardClick(operatorId: string, token: string, messageId: string): CardActionEvent {
  return {
    action: { value: { cmd: 'auto.confirm', auto_token: token } },
    chatId: CHAT,
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

function isBoardContent(content: unknown): boolean {
  return JSON.stringify(content).includes('本群自动化');
}

function latestBoard(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): {
  messageId: string;
  text: string;
} {
  const updated = [...h.channel.updatedCards].reverse().find((item) => isBoardContent(item.card));
  if (updated) {
    return { messageId: updated.messageId, text: JSON.stringify(updated.card) };
  }
  const send = [...h.channel.sent].reverse().find((item) => isBoardContent(item.content));
  expect(send, 'expected a board card in chat').toBeDefined();
  const content = send!.content as { card?: unknown };
  return {
    messageId: h.channel.pins.at(-1)?.messageId ?? messageIdFromSend(h, send!),
    text: JSON.stringify(content.card ?? send!.content),
  };
}

function messageIdFromSend(
  h: { channel: ReturnType<typeof createRecordingLarkChannel> },
  send: { chatId: string; content: unknown },
): string {
  const index = h.channel.sent.indexOf(send);
  return `om_fake_${index + 1}`;
}

function statusBlock(cardJson: string): {
  v: number;
  bot: string;
  updatedAt: number;
  items: Array<{
    id: number;
    paused: boolean;
    nextFireAt: number;
    lastFireAt: number;
    lastStatus: string;
    endAt: number;
    missed: number;
  }>;
} {
  const escaped = cardJson.indexOf('{\\"v\\":1');
  const source = escaped >= 0 ? cardJson.slice(escaped).replace(/\\"/g, '"') : cardJson;
  const match = source.match(/\{"v":1,[\s\S]*?"items":\[[^\]]*\]\}/);
  expect(match?.[0], 'expected a status block v1 JSON note').toBeDefined();
  return JSON.parse(match![0]!) as ReturnType<typeof statusBlock>;
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function lastMarkdown(channel: ReturnType<typeof createRecordingLarkChannel>): string {
  const send = [...channel.sent].reverse().find((item) => {
    const content = item.content as { markdown?: unknown };
    return typeof content?.markdown === 'string';
  });
  expect(send, 'expected a markdown reply').toBeDefined();
  return (send!.content as { markdown: string }).markdown;
}
