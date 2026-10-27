import { draftConfirmationDelivery } from '../../../src/automations/draft-confirmation';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOARD_CARD_TTL_MS } from '../../../src/automations/board-auth';
import { AUTO_INVALID_HINT, AUTO_P2P_HINT, AUTO_UNKNOWN_ID } from '../../../src/automations/command';
import { CATCH_UP_WINDOW_MS } from '../../../src/automations/schedule';
import { AutomationsStore } from '../../../src/automations/store';
import { FEISHU_LINK_SILENT_PROBE_MS, FEISHU_LINK_TICK_MS } from '../../../src/bot/feishu-link';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { cardButtonValue } from '../../helpers/card-button-value';
import { CardSchemaError } from '../../helpers/card-schema2';
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
  it('posts a pinned human-only board after confirm, and pause updates it in place', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new in 15m | 交周报 | 提醒交周报'));
    const confirm = confirmCard(h);
    await h.channel.handlers.cardAction?.(
      cardClick(MATE, confirmToken(confirm), draftConfirmationDelivery(h.store.listDrafts()[0]!).messageId!),
    );
    await waitForBoard(h);

    const board = latestBoard(h);
    expect(board.text).toContain('#1');
    expect(board.text).toContain('交周报');
    expect(board.text).toContain('提醒');
    expect(board.text).toContain('暂停');
    expect(board.text).toContain('删除');
    expect(board.text).toContain('尚未运行');
    expect(board.text).not.toContain('提醒交周报');
    expectNoStatusBlock(board.text);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([board.messageId]);

    const status = JSON.parse(await readFile(h.statusPath, 'utf8')) as {
      v: number;
      bot: string;
      updatedAt: number;
      items: Array<{
        id: number;
        paused: boolean;
        nextFireAt: number;
        lastFireAt: number;
        lastStatus: string;
        missed: number;
      }>;
    };
    expect(status.v).toBe(1);
    expect(status.bot).toBe('Pin Bot');
    expect(status.items).toEqual([
      expect.objectContaining({
        id: 1,
        paused: false,
        nextFireAt: FIRE_AT,
        lastFireAt: 0,
        lastStatus: 'never',
        missed: 0,
      }),
    ]);
    expect(JSON.stringify(status)).not.toMatch(/\b(oc|om|ou|on)_[A-Za-z0-9]+/);
    expect(JSON.stringify(status)).not.toContain('提醒交周报');
    expect(JSON.stringify(status)).not.toContain(USER);
    await expect(readFile(h.logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const sendsBeforePause = h.channel.sent.filter((item) => isBoardContent(item.content)).length;
    const updatesBeforePause = h.channel.updatedCards.length;
    const originalPause = pauseToken(board.text);
    h.setNow(h.now() + 1);
    const pauseClick = await h.channel.handlers.cardAction?.(
      boardClick(USER, originalPause, board.messageId, 'auto.pause'),
    );
    expect(pauseClick).toEqual({ toast: { type: 'success', content: '已暂停 #1' } });
    expect(h.store.get(1)?.paused).toBe(true);
    expect(h.channel.updatedCards).toHaveLength(updatesBeforePause);
    expect(latestBoard(h).text).toContain('"cmd":"auto.pause"');
    expect(latestBoard(h).text).not.toContain('"cmd":"auto.resume"');

    await waitFor(() => latestBoard(h).text.includes('"cmd":"auto.resume"'));
    const paused = latestBoard(h);
    expect(paused.messageId).toBe(board.messageId);
    expect(h.channel.sent.filter((item) => isBoardContent(item.content))).toHaveLength(sendsBeforePause);
    expect(h.channel.updatedCards).toHaveLength(updatesBeforePause + 1);
    expectNoStatusBlock(paused.text);
    const pausedStatus = JSON.parse(await readFile(h.statusPath, 'utf8')) as {
      updatedAt: number;
      items: Array<{ paused: boolean }>;
    };
    expect(pausedStatus.items[0]?.paused).toBe(true);
    expect(pausedStatus.updatedAt).toBeGreaterThan(status.updatedAt);

    await h.channel.handlers.cardAction?.(
      boardClick(MATE, originalPause, paused.messageId, 'auto.pause'),
    );
    expect(h.store.get(1)?.paused).toBe(true);

    const forged = await h.channel.handlers.cardAction?.(
      boardClick(USER, 'forged-board-token', paused.messageId, 'auto.pause'),
    );
    expect(forged).toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
    expect(markdowns(h.channel)).not.toContain(AUTO_INVALID_HINT);
    expect(h.store.get(1)?.paused).toBe(true);
  });

  it('toasts AUTO_INVALID_HINT for an expired board token and AUTO_UNKNOWN_ID when the item is gone', async () => {
    const h = await harness();
    await confirmOne(h);
    const board = latestBoard(h);
    const token = pauseToken(board.text);
    h.setNow(h.now() + BOARD_CARD_TTL_MS + 1);
    const expired = await h.channel.handlers.cardAction?.(
      boardClick(USER, token, board.messageId, 'auto.pause'),
    );
    expect(expired).toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
    expect(h.store.get(1)?.paused).toBe(false);
    expect(markdowns(h.channel)).not.toContain(AUTO_INVALID_HINT);

    h.setNow(NOW);
    expect(await h.store.delete(1)).toBe(true);
    const missing = await h.channel.handlers.cardAction?.(
      boardClick(USER, token, board.messageId, 'auto.pause'),
    );
    expect(missing).toEqual({ toast: { type: 'error', content: AUTO_UNKNOWN_ID } });
    expect(markdowns(h.channel)).not.toContain(AUTO_UNKNOWN_ID);
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
    expectNoStatusBlock(board.text);

    const status = JSON.parse(await readFile(h.statusPath, 'utf8')) as {
      items: Array<{ id: number; missed: number }>;
    };
    expect(status.items[0]).toMatchObject({ id: 1, missed: 2 });
    expect(JSON.stringify(status)).not.toContain('secret ping body');
    expect(JSON.stringify(status)).not.toContain(USER);
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
    await waitFor(() => !latestBoard(h).text.includes('已错过 原定 2026-01-02 12:00'));
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
    await waitFor(() => h.channel.pins.some((pin) => pin.messageId === board.messageId));
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
    await waitForBoard(h);
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
    expectNoStatusBlock(latestBoard(h).text);
  });

  it('lists and mutates tasks through /auto fallback commands', async () => {
    const h = await harness();
    await confirmOne(h);
    await h.channel.handlers.message?.(mention('om_list', '/auto'));
    expect(lastMarkdown(h.channel)).toContain('#1 交周报');
    expect(lastMarkdown(h.channel)).toContain('提醒');
    expect(lastMarkdown(h.channel)).toContain('尚未运行');

    await h.channel.handlers.message?.(mention('om_pause', '/auto pause 1'));
    expect(h.store.get(1)?.paused).toBe(true);
    await waitFor(() => latestBoard(h).text.includes('"cmd":"auto.resume"'));
    expectNoStatusBlock(latestBoard(h).text);

    await h.channel.handlers.message?.(mention('om_resume', '/auto resume 1'));
    expect(h.store.get(1)?.paused).toBe(false);

    await h.channel.handlers.message?.(mention('om_delete', '/auto delete 1'));
    expect(h.store.list()).toEqual([]);
    await waitFor(() => latestBoard(h).text.includes('暂无'));
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
    await waitFor(() => {
      const nextId = latestBoard(h).messageId;
      return nextId !== first.messageId
        && h.channel.pins.some((pin) => pin.messageId === nextId);
    });
    const next = latestBoard(h);
    expect(next.messageId).not.toBe(first.messageId);
    expectNoStatusBlock(next.text);
    expect(h.store.get(1)?.paused).toBe(true);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([next.messageId]);
  });

  it('omits cardId from the board binding after a raw-card fallback send', async () => {
    const h = await harness({ rawCardFallback: true });
    await confirmOne(h);
    const binding = h.store.getBoard(CHAT);
    expect(binding?.cardId).toBeUndefined();
    expect(binding?.messageId).toBeTypeOf('string');
    const board = latestBoard(h);
    await h.channel.handlers.cardAction?.(
      boardClick(USER, pauseToken(board.text), board.messageId, 'auto.pause'),
    );
    expect(h.store.get(1)?.paused).toBe(true);
    await waitFor(() => h.channel.callLog.some((call) => call.op === 'updateCard' && call.messageId === board.messageId));
    expect(h.channel.updatedCards.some(update => update.messageId === board.messageId)).toBe(true);
  });

  it('pauses, resumes, and deletes through board callbacks', async () => {
    const h = await harness();
    await confirmOne(h);
    const board = latestBoard(h);
    const pausedTap = await h.channel.handlers.cardAction?.(
      boardClick(USER, pauseToken(board.text), board.messageId, 'auto.pause'),
    );
    expect(pausedTap).toEqual({ toast: { type: 'success', content: '已暂停 #1' } });
    expect(h.store.get(1)?.paused).toBe(true);
    await waitFor(() => latestBoard(h).text.includes('"cmd":"auto.resume"'));

    const paused = latestBoard(h);
    const resumedTap = await h.channel.handlers.cardAction?.(
      boardClick(MATE, boardToken(paused.text, 'auto.resume'), paused.messageId, 'auto.resume'),
    );
    expect(resumedTap).toEqual({ toast: { type: 'success', content: '已恢复 #1' } });
    expect(h.store.get(1)?.paused).toBe(false);
    await waitFor(() => latestBoard(h).text.includes('"cmd":"auto.pause"'));

    const live = latestBoard(h);
    const deletedTap = await h.channel.handlers.cardAction?.(
      boardClick(USER, boardToken(live.text, 'auto.delete'), live.messageId, 'auto.delete'),
    );
    expect(deletedTap).toEqual({ toast: { type: 'success', content: '已删除 #1' } });
    expect(h.store.list()).toEqual([]);
    await waitFor(() => latestBoard(h).text.includes('暂无'));
  });

  it('accepts the full rendered board button value including its click id', async () => {
    const h = await harness();
    await confirmOne(h);
    const board = latestBoard(h);
    const value = cardButtonValue(JSON.parse(board.text), 'auto.pause');
    expect(typeof value.a).toBe('string');
    const tap = await h.channel.handlers.cardAction?.({
      action: { value },
      chatId: CHAT,
      messageId: board.messageId,
      operator: { openId: USER, name: 'Op' },
    } as unknown as CardActionEvent);
    expect(tap).toEqual({ toast: { type: 'success', content: '已暂停 #1' } });
    expect(h.store.get(1)?.paused).toBe(true);
  });

  it('still refreshes the board when the first cardless draft fails on link recovery', async () => {
    const h = await harness();
    await confirmOne(h);
    h.channel.connectionState = 'reconnecting';
    await h.bridge.tickLink();
    await h.channel.handlers.message?.(mention('om_a', '/auto new in 15m | 甲 | 提醒甲'));
    await h.channel.handlers.message?.(mention('om_b', '/auto new in 20m | 乙 | 提醒乙'));
    expect(h.store.listDrafts().map((draft) => draftConfirmationDelivery(draft).messageId)).toEqual([undefined, undefined]);

    const order: string[] = [];
    const origCreate = h.channel.createCard.bind(h.channel);
    h.channel.createCard = async (card) => {
      order.push('create');
      return origCreate(card);
    };
    const origUpdate = h.channel.rawClient.cardkit.v1.card.update.bind(h.channel.rawClient.cardkit.v1.card);
    h.channel.rawClient.cardkit.v1.card.update = async (params) => {
      order.push('update');
      return origUpdate(params);
    };
    h.channel.cardErrors.create = new CardSchemaError();
    h.channel.connectionState = 'connected';
    await h.bridge.tickLink();
    await waitFor(() => {
      const drafts = h.store.listDrafts();
      const first = drafts[0];
      return drafts.length === 1
        && Boolean(first && 'name' in first && first.name === '乙')
        && Boolean(draftConfirmationDelivery(first).messageId)
        && order.at(-1) === 'update';
    });

    expect(h.store.listDrafts().map((draft) => ('name' in draft ? draft.name : undefined))).toEqual(['乙']);
    expect(markdowns(h.channel)).toContain('确认卡片发送失败（飞书错误 200610），未创建任务。请稍后重试。');
    expect(order.at(-1)).toBe('update');
  });

  it('does not POST status when endpoint or secret is missing', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const h = await harness();
      await confirmOne(h);
      expectNoStatusBlock(latestBoard(h).text);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('POSTs a signed v2 payload after confirm when status push is configured', async () => {
    const posts: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      posts.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const h = await harness({
        statusEndpoint: 'https://status.test',
        statusSecret: 'unit-status-secret',
      });
      await confirmOne(h);
      await waitFor(() => posts.length > 0, 5_000);
      expect(posts[0]?.url).toBe('https://status.test/v1/status');
      const body = JSON.parse(posts[0]!.body) as {
        v: number;
        botKey: string;
        items: Array<{ id: string; lastFireAt: number; paused: boolean }>;
      };
      expect(body.v).toBe(2);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.paused).toBe(false);
      expect(JSON.stringify(body)).not.toMatch(/\b(oc|om|ou|on|cli)_/);
      expect(JSON.stringify(body)).not.toContain('交周报');
      expect(JSON.stringify(body)).not.toContain('unit-status-secret');
      expectNoStatusBlock(latestBoard(h).text);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('toasts the new board hint for a pending old pause and does not change the task', async () => {
    const h = await harness();
    await confirmOne(h);
    const board = latestBoard(h);
    const live = h.store.getBoard(CHAT)!;
    await h.store.setBoard({ ...live, pendingUnpinMessageIds: ['om_pending_old'] });
    const writes = h.channel.updatedCards.length;
    const sent = h.channel.sent.length;
    const stale = await h.channel.handlers.cardAction?.(
      boardClick(USER, pauseToken(board.text), 'om_pending_old', 'auto.pause'),
    );
    expect(stale).toEqual({
      toast: { type: 'error', content: '此看板已更新，请使用置顶的新看板。' },
    });
    expect(h.store.get(1)?.paused).toBe(false);
    expect(h.channel.updatedCards).toHaveLength(writes);
    expect(h.channel.sent).toHaveLength(sent);
  });

  it('toasts the new board hint for a delete on a released old board', async () => {
    const h = await harness();
    await confirmOne(h);
    const board = latestBoard(h);
    const writes = h.channel.updatedCards.length;
    const sent = h.channel.sent.length;
    const stale = await h.channel.handlers.cardAction?.(
      boardClick(USER, boardToken(board.text, 'auto.delete'), 'om_released_old', 'auto.delete'),
    );
    expect(stale).toEqual({
      toast: { type: 'error', content: '此看板已更新，请使用置顶的新看板。' },
    });
    expect(h.store.get(1)?.id).toBe(1);
    expect(h.channel.updatedCards).toHaveLength(writes);
    expect(h.channel.sent).toHaveLength(sent);
  });
});

async function harness(opts: {
  enabled?: boolean;
  nowMs?: number;
  rawCardFallback?: boolean;
  statusEndpoint?: string;
  statusSecret?: string;
} = {}) {
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
    ...(opts.statusEndpoint ? { statusEndpoint: opts.statusEndpoint } : {}),
    ...(opts.statusSecret ? { statusSecret: opts.statusSecret } : {}),
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
  if (opts.rawCardFallback) {
    const origSend = channel.send.bind(channel);
    channel.send = (async (recipientId, content, sendOpts) => {
      if (content && typeof content === 'object' && 'cardId' in content && !('card' in content) && !(sendOpts as { replyTo?: string } | undefined)?.replyTo) {
        throw new Error('cardid is invalid');
      }
      return origSend(recipientId, content, sendOpts);
    }) as typeof channel.send;
  }
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
    cardClick(USER, confirmToken(card), draftConfirmationDelivery(h.store.listDrafts()[0]!).messageId!),
  );
  await waitForBoard(h);
}

async function waitForBoard(h: { store: AutomationsStore; channel: ReturnType<typeof createRecordingLarkChannel> }): Promise<void> {
  await waitFor(() => {
    const binding = h.store.getBoard(CHAT);
    return Boolean(binding)
      && h.channel.sent.some((item) => isBoardContent(item.content))
      && h.channel.pins.some((pin) => pin.messageId === binding!.messageId);
  });
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
  const match = cardJson.match(/"cmd":"auto.confirm","auto_token":"(auto_cb\.v[0-9]+\.[^"]+)"/);
  expect(match?.[1], 'expected auto.confirm token').toBeDefined();
  return match![1]!;
}

function pauseToken(cardJson: string): string {
  return boardToken(cardJson, 'auto.pause');
}

function boardToken(cardJson: string, cmd: 'auto.pause' | 'auto.resume' | 'auto.delete'): string {
  const match = cardJson.match(new RegExp(`"cmd":"${cmd}","auto_token":"(auto_board\\.v[0-9]+\\.[^"]+)"`));
  expect(match?.[1], `expected ${cmd} token`).toBeDefined();
  return match![1]!;
}

function markdowns(channel: ReturnType<typeof createRecordingLarkChannel>): string[] {
  return channel.sent.flatMap((item) => {
    const content = item.content as { markdown?: unknown };
    return typeof content?.markdown === 'string' ? [content.markdown] : [];
  });
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
  const pinned = new Set(h.channel.pins.map((pin) => pin.messageId));
  const updated = [...h.channel.updatedCards].reverse().find((item) => (
    isBoardContent(item.card) && (pinned.size === 0 || pinned.has(item.messageId))
  ));
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
  send: ReturnType<typeof createRecordingLarkChannel>['sent'][number],
): string {
  const index = h.channel.sent.indexOf(send);
  return `om_fake_${index + 1}`;
}

function expectNoStatusBlock(cardJson: string): void {
  expect(cardJson).not.toContain('notation');
  expect(cardJson).not.toContain('"v":1');
  expect(cardJson).not.toContain('"v":2');
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
