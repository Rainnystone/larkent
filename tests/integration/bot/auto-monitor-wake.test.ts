import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATCH_UP_WINDOW_MS,
  formatFireKey,
  isMissed,
} from '../../../src/automations/schedule';
import {
  simplifiedBoardRender,
  statusBlockIsMissed,
} from '../../../src/automations/status-block';
import { AutomationsStore } from '../../../src/automations/store';
import { enqueueWakeRequest } from '../../../src/automations/wake-file';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { log } from '../../../src/core/logger';
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
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const T0 = Date.UTC(2026, 0, 2, 12, 0, 0);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('automation monitor wake hook', () => {
  it('a simplified board render parses as v1 and the miss rule matches Larkent for the same now', async () => {
    const fireAt = T0 + 15 * 60_000;
    const h = await harness({ nowMs: T0 });
    await seedItem(h, fireAt);
    await h.restart();

    const board = latestBoard(h);
    const visible = simplifiedBoardRender(JSON.parse(board.text) as object);
    expect(visible).not.toContain('"v":1');
    expect(visible).not.toMatch(/\{/);
    const status = JSON.parse(await readFile(h.statusPath, 'utf8')) as {
      v: number;
      bot: string;
      items: Array<{
        id: number;
        paused: boolean;
        nextFireAt: number;
        lastFireAt: number;
        lastStatus: string;
      }>;
    };
    expect(status.v).toBe(1);
    expect(status.bot).toBe('Grok Bot');
    const hookItem = status.items[0];
    expect(hookItem).toMatchObject({
      id: 1,
      paused: false,
      nextFireAt: fireAt,
      lastFireAt: 0,
      lastStatus: 'ok',
    });
    const live = h.store.get(1)!;
    expect(JSON.stringify(status)).not.toContain('secret ping body');
    expect(JSON.stringify(status)).not.toContain(USER);
    for (const at of [T0, fireAt, fireAt + 1, fireAt + CATCH_UP_WINDOW_MS + 1]) {
      const specMiss = !hookItem!.paused
        && hookItem!.nextFireAt > 0
        && at > hookItem!.nextFireAt
        && hookItem!.lastFireAt < hookItem!.nextFireAt;
      expect(isMissed({
        id: live.id,
        paused: live.paused,
        nextFireAt: live.nextFireAt,
        lastFireAt: live.lastFireAt,
        schedule: { kind: 'one-shot', fireAt },
      }, at), `now=${at}`).toBe(specMiss);
      expect(statusBlockIsMissed(hookItem!, at), `now=${at}`).toBe(specMiss);
    }
  });

  it('wake for an already-started fire key sends nothing, does not patch the board, and only logs locally', async () => {
    const fireAt = T0;
    const h = await harness({ nowMs: fireAt + 60_000 });
    await seedItem(h, fireAt);
    await h.restart();
    const fireKey = formatFireKey(1, fireAt);
    expect(h.store.hasStarted(fireKey)).toBe(true);
    const sentBefore = h.channel.sent.length;
    const updatesBefore = h.channel.updatedCards.length;
    const logBefore = await readLog(h);
    const statusBefore = await readFile(h.statusPath, 'utf8');
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    try {
      await enqueueWakeRequest(h.wakeDir, fireKey);
      await waitFor(() => info.mock.calls.some((call) =>
        call[0] === 'auto' && call[1] === 'wake.already-started',
      ));
    } finally {
      info.mockRestore();
    }
    expect(h.channel.sent).toHaveLength(sentBefore);
    expect(h.channel.updatedCards).toHaveLength(updatesBefore);
    expect(await readLog(h)).toEqual(logBefore);
    expect(await readFile(h.statusPath, 'utf8')).toBe(statusBefore);
  });

  it('wake for a missed fire key within 24 h catch-up once; a repeat is silent', async () => {
    const fireAt = T0;
    const h = await harness({ nowMs: fireAt - 15 * 60_000 });
    await seedItem(h, fireAt);
    await h.restart();
    expect(h.store.hasStarted(formatFireKey(1, fireAt))).toBe(false);
    await h.store.setNextFireAt(1, fireAt);
    h.setNow(fireAt + 61_000);

    const sentBefore = h.channel.sent.length;
    const fireKey = formatFireKey(1, fireAt);
    await enqueueWakeRequest(h.wakeDir, fireKey);
    await waitFor(async () => {
      const logReady = (await readLog(h)).some((entry) =>
        entry.result === 'catch-up' && entry.scheduledAt === fireAt && entry.triggerSource === 'wake',
      );
      if (!logReady || h.store.get(1) !== undefined) return false;
      try {
        const status = JSON.parse(await readFile(h.statusPath, 'utf8')) as { items: unknown[] };
        if (status.items.length !== 0) return false;
        return latestBoard(h).text.includes('暂无');
      } catch {
        return false;
      }
    });

    const logAfter = await readLog(h);
    expect(logAfter.filter((entry) => entry.result === 'catch-up')).toEqual([
      expect.objectContaining({
        result: 'catch-up',
        scheduledAt: fireAt,
        triggerSource: 'wake',
      }),
    ]);
    expect(h.store.hasStarted(fireKey)).toBe(true);
    const status = JSON.parse(await readFile(h.statusPath, 'utf8')) as { v: number; items: unknown[] };
    expect(status.v).toBe(1);
    expect(h.store.get(1)).toBeUndefined();
    expect(latestBoard(h).text).toContain('暂无');
    expect(h.channel.sent.length).toBeGreaterThanOrEqual(sentBefore);

    const sentAfter = h.channel.sent.length;
    const updatesAfter = h.channel.updatedCards.length;
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    try {
      await enqueueWakeRequest(h.wakeDir, fireKey);
      await waitFor(() => info.mock.calls.some((call) =>
        call[0] === 'auto' && call[1] === 'wake.already-started',
      ));
    } finally {
      info.mockRestore();
    }
    expect(await readLog(h)).toEqual(logAfter);
    expect(h.channel.sent).toHaveLength(sentAfter);
    expect(h.channel.updatedCards).toHaveLength(updatesAfter);
  });

  it('is silent when Larkent already restarted and then the wake arrives', async () => {
    const fireAt = T0;
    const h = await harness({ nowMs: fireAt + 60_000 });
    await seedItem(h, fireAt);
    await h.restart();
    const fireKey = formatFireKey(1, fireAt);
    expect(h.store.hasStarted(fireKey)).toBe(true);
    await h.restart();
    const sentBefore = h.channel.sent.length;
    const updatesBefore = h.channel.updatedCards.length;
    const logBefore = await readLog(h);
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    try {
      await enqueueWakeRequest(h.wakeDir, fireKey);
      await waitFor(() => info.mock.calls.some((call) =>
        call[0] === 'auto' && call[1] === 'wake.already-started',
      ));
    } finally {
      info.mockRestore();
    }
    expect(h.channel.sent).toHaveLength(sentBefore);
    expect(h.channel.updatedCards).toHaveLength(updatesBefore);
    expect(await readLog(h)).toEqual(logBefore);
  });

  it('starts from a stop with a pending wake file and catch-up once', async () => {
    const fireAt = T0;
    const h = await harness({ nowMs: fireAt + 61_000, start: false });
    await seedItem(h, fireAt);
    const fireKey = formatFireKey(1, fireAt);
    await enqueueWakeRequest(h.wakeDir, fireKey);
    expect(h.channel.sent).toEqual([]);
    await h.restart();

    const logEntries = await readLog(h);
    const catchUps = logEntries.filter((entry) => entry.result === 'catch-up');
    expect(catchUps).toEqual([
      expect.objectContaining({
        result: 'catch-up',
        scheduledAt: fireAt,
      }),
    ]);
    expect(['startup', 'link-recovered']).toContain(catchUps[0]?.triggerSource);
    expect(h.store.hasStarted(fireKey)).toBe(true);
    expect(h.store.get(1)).toBeUndefined();
    const status = JSON.parse(await readFile(h.statusPath, 'utf8')) as { v: number };
    expect(status.v).toBe(1);
  });

  it('wake for a fire key older than 24 h does not send and shows 已错过 with an A0c log', async () => {
    const fireAt = T0;
    const h = await harness({ nowMs: fireAt - 15 * 60_000 });
    await seedItem(h, fireAt);
    await h.restart();
    await h.store.setNextFireAt(1, fireAt);
    h.setNow(fireAt + CATCH_UP_WINDOW_MS + 1);

    await enqueueWakeRequest(h.wakeDir, formatFireKey(1, fireAt));
    await waitFor(async () => {
      const logReady = (await readLog(h)).some((entry) =>
        entry.result === 'missed' && entry.scheduledAt === fireAt,
      );
      if (!logReady) return false;
      try {
        const board = latestBoard(h);
        if (!board.text.includes('已错过 原定 2026-01-02 12:00')) return false;
        const status = JSON.parse(await readFile(h.statusPath, 'utf8')) as {
          items: Array<{ lastStatus?: string; missed?: number }>;
        };
        return status.items[0]?.lastStatus === 'missed' && status.items[0]?.missed === 1;
      } catch {
        return false;
      }
    });

    expect(h.store.hasStarted(formatFireKey(1, fireAt))).toBe(false);
    const logEntries = await readLog(h);
    expect(logEntries.filter((entry) => entry.result === 'catch-up')).toEqual([]);
    expect(logEntries.filter((entry) => entry.result === 'missed')).toEqual([
      expect.objectContaining({
        result: 'missed',
        scheduledAt: fireAt,
        triggerSource: 'wake',
      }),
    ]);
    const board = latestBoard(h);
    expect(board.text).toContain('已错过 原定 2026-01-02 12:00');
    expect(simplifiedBoardRender(JSON.parse(board.text) as object)).not.toContain('"v":1');
    const status = JSON.parse(await readFile(h.statusPath, 'utf8')) as {
      v: number;
      items: Array<{ id: number; lastStatus: string; nextFireAt: number; missed: number }>;
    };
    expect(status.v).toBe(1);
    expect(status.items[0]).toMatchObject({
      id: 1,
      lastStatus: 'missed',
      nextFireAt: 0,
      missed: 1,
    });
  });
});

async function harness(opts: { nowMs?: number; start?: boolean } = {}) {
  const tmp = await createTmpProfile('auto-wake-');
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
      allowedUsers: [USER],
      allowedChats: [CHAT],
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
    timezone: 'UTC',
  };
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(CHAT, tmp.workspace);
  const agent = new FakeAgentAdapter({ id: 'claude' });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
    chatMode: 'group',
    botIdentity: { openId: 'ou_bot', name: 'Grok Bot' },
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
      processId: 'test-auto-wake',
    },
  });
  let bridge = opts.start === false ? undefined : await start();
  cleanups.push(async () => {
    await bridge?.disconnect().catch(() => {});
    await store.flush().catch(() => {});
    await tmp.cleanup();
  });
  return {
    channel,
    store,
    tmp,
    wakeDir: join(tmp.profile, 'automations-wake'),
    statusPath: join(tmp.profile, 'automations-status.json'),
    logPath: join(tmp.profile, 'automations.log'),
    get bridge() {
      if (!bridge) throw new Error('bridge is not started');
      return bridge;
    },
    now,
    setNow(next: number) {
      nowMs = next;
    },
    async restart() {
      if (bridge) await bridge.disconnect();
      bridge = await start();
    },
  };
}

async function seedItem(h: Awaited<ReturnType<typeof harness>>, fireAt: number): Promise<void> {
  await h.store.create({
    taskType: 'reminder',
    schedule: { kind: 'one-shot', fireAt },
    timezone: 'UTC',
    startAt: fireAt - 20 * 60_000,
    endAt: fireAt,
    nextFireAt: fireAt,
    chatId: CHAT,
    createdBy: USER,
    name: '交周报',
    taskText: 'secret ping body',
  });
}

async function readLog(h: { logPath: string }): Promise<Array<{
  result: string;
  scheduledAt: number;
  triggerSource: string;
}>> {
  try {
    return (await readFile(h.logPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        result: string;
        scheduledAt: number;
        triggerSource: string;
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
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
    messageId: h.channel.pins.at(-1)?.messageId ?? 'om_board',
    text: JSON.stringify(content.card ?? send!.content),
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
