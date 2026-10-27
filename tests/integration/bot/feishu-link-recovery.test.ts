import { mkdir, rename, rm } from 'node:fs/promises';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { WATERMARK_MARGIN_MS } from '../../../src/bot/backfill';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import { FEISHU_LINK_SILENT_PROBE_MS, FEISHU_LINK_TICK_MS } from '../../../src/bot/feishu-link';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { log } from '../../../src/core/logger';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel, isBackfillDelayLine } from '../../helpers/recording-lark-channel';
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

const BOT = 'ou_bot';
const USER = 'ou_user';
const CHAT = 'oc_group';
const NOW = 1_760_000_000_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('FeishuLink recovery through the bridge', () => {
  it('answers a mention posted during a 2 min connected probe outage exactly once', async () => {
    let now = NOW;
    let probeOk = true;
    const recovered: Array<{ since: number; until: number }> = [];
    const failureStart = NOW + FEISHU_LINK_SILENT_PROBE_MS;
    const postedAt = failureStart + 30_000;
    const history: Record<string, unknown[]> = {
      [CHAT]: [],
    };
    const h = await startHarness({
      now: () => now,
      probe: async () => probeOk,
      lastLiveAt: NOW,
      history,
      onRecovered: (outage) => {
        recovered.push(outage);
      },
    });

    expect(recovered).toHaveLength(1);
    // Startup recover is fire-and-forget after the first tick. Join the
    // in-flight pass before the silent-probe clock starts, or lastEvidenceAt
    // jumps and the outage window starts after failureStart.
    await h.bridge.recover();
    recovered.length = 0;

    probeOk = false;
    while (now < failureStart) {
      now += FEISHU_LINK_TICK_MS;
      await h.bridge.tickLink();
    }
    history[CHAT] = [mentionItem('om_blackhole', CHAT, 'missed while REST was down', postedAt)];
    const downFor = now + 2 * 60_000;
    while (now < downFor) {
      now += FEISHU_LINK_TICK_MS;
      await h.bridge.tickLink();
    }
    expect(recovered).toHaveLength(0);
    expect(h.agent.runOptions).toHaveLength(0);

    probeOk = true;
    now += FEISHU_LINK_TICK_MS;
    await h.bridge.tickLink();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.since).toBeLessThanOrEqual(failureStart);

    await h.bridge.recover();
    await waitForDebounce();
    await until(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]!.prompt).toContain('missed while REST was down');
    const calls = h.channel.snapshotCalls();
    const isDelayLine = (call: (typeof calls)[number]): boolean => call.op === 'send' && isBackfillDelayLine(call);
    const replies = calls.filter((call) => (call.op === 'send' || call.op === 'stream') && !isDelayLine(call));
    expect(replies).toHaveLength(1);
    expect(calls.filter(isDelayLine)).toHaveLength(1);
  });

  it('resends a staged reply exactly once after recovery and never while up', async () => {
    let now = NOW;
    const h = await startHarness({
      now: () => now,
      probe: async () => true,
      lastLiveAt: NOW,
      history: { [CHAT]: [] },
      withJournal: true,
    });
    expect(h.ledger.getLiveAt()).toBe(NOW);
    expect(h.journal).toBeDefined();
    // Drain startup Recovery before staging so its redeliver does not
    // observe a reply enqueued after the outage callback fired.
    await h.bridge.recover();

    h.journal!.enqueue({
      turnId: 'turn-staged',
      scope: CHAT,
      chatId: CHAT,
      messageIds: ['om_src'],
      senderId: USER,
      initiatorId: USER,
      status: 'completed-undelivered',
      reply: {
        markdown: 'STAGED_ONCE',
        replyTo: 'om_src',
        replyMode: 'text',
      },
    });
    await h.journal!.flush();

    const stagedSends = () => h.channel.sent.filter((item) =>
      JSON.stringify(item.content).includes('STAGED_ONCE'),
    );

    for (let n = 0; n < 3; n++) {
      now += FEISHU_LINK_TICK_MS;
      await h.bridge.tickLink();
    }
    expect(stagedSends()).toHaveLength(0);

    h.channel.connectionState = 'reconnecting';
    await h.bridge.tickLink();
    expect(stagedSends()).toHaveLength(0);

    h.channel.connectionState = 'connected';
    await h.bridge.tickLink();
    await h.bridge.recover();
    expect(h.journal!.get('turn-staged')?.status).toBe('reply-delivered');
    expect(stagedSends()).toHaveLength(1);

    await h.bridge.recover();
    expect(stagedSends()).toHaveLength(1);

    h.channel.connectionState = 'reconnecting';
    await h.bridge.tickLink();
    h.channel.connectionState = 'connected';
    await h.bridge.tickLink();
    await h.bridge.recover();
    expect(stagedSends()).toHaveLength(1);
  });

  it('redelivers a staged reply on the next recovery after journal flush throws', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const h = await startHarness({
      now: () => NOW,
      probe: async () => true,
      lastLiveAt: NOW,
      history: { [CHAT]: [] },
      withJournal: true,
    });
    expect(h.ledger.getLiveAt()).toBe(NOW);
    await h.bridge.recover();

    h.journal!.enqueue({
      turnId: 'turn-flush-throw',
      scope: CHAT,
      chatId: CHAT,
      messageIds: ['om_src_flush'],
      senderId: USER,
      initiatorId: USER,
      status: 'completed-undelivered',
      reply: {
        markdown: 'FLUSH_RETRY',
        replyTo: 'om_src_flush',
        replyMode: 'text',
      },
    });
    await h.journal!.flush();
    const journalPath = h.journal!.getFilePath();
    await rename(journalPath, `${journalPath}.backup`);
    await mkdir(journalPath);
    h.journal!.noteTurnMeta('turn-flush-throw', { resumeHandle: 'persist-failure' });
    await expect(h.journal!.flush()).rejects.toBeDefined();

    const stagedSends = () => h.channel.sent.filter((item) =>
      JSON.stringify(item.content).includes('FLUSH_RETRY'),
    );

    await h.bridge.recover({ since: NOW - 1_000, until: NOW, hostSuspended: false });
    expect(stagedSends()).toHaveLength(0);
    expect(fail.mock.calls.some((call) => call[0] === 'recovery')).toBe(true);

    await rm(journalPath, { recursive: true });
    await rename(`${journalPath}.backup`, journalPath);
    await h.journal!.load();
    await h.bridge.recover({ since: NOW - 1_000, until: NOW, hostSuspended: false });
    expect(stagedSends()).toHaveLength(1);
  });

  it('keeps the bridge alive when automatic recovery rejects', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    try {
      const h = await startHarness({
        now: () => NOW,
        probe: async () => true,
        lastLiveAt: NOW,
        history: { [CHAT]: [] },
        withJournal: true,
        failHistory: true,
      });
      await h.bridge.recover();
      expect(rejections, String(rejections[0])).toEqual([]);
      expect(fail.mock.calls.some((call) => call[0] === 'recovery')).toBe(true);

      await h.channel.handlers.message?.(mention('om_live', 'still listening'));
      await waitForDebounce();
      await until(() => h.agent.runOptions.length === 1);
      expect(h.agent.runOptions[0]?.prompt).toContain('still listening');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not resend or backfill on connected ticks', async () => {
    let now = NOW;
    const h = await startHarness({
      now: () => now,
      probe: async () => true,
      lastLiveAt: NOW,
      history: { [CHAT]: [] },
    });
    expect(h.ledger.getLiveAt()).toBe(NOW);
    // Join startup recover before the connected-tick loop advances `now`.
    await h.bridge.recover();
    const listed = h.channel.listChatsCalls;
    const liveAt = h.ledger.getLiveAt();

    for (let n = 0; n < 3; n++) {
      now += FEISHU_LINK_TICK_MS;
      await h.bridge.tickLink();
    }
    expect(h.channel.listChatsCalls).toBe(listed);
    expect(h.ledger.getLiveAt()).toBe(liveAt);
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('backfills an outage after shutdown during recovered history listing', async () => {
    let now = NOW;
    const history: Record<string, unknown[]> = { [CHAT]: [] };
    const h = await startHarness({
      now: () => now,
      probe: async () => true,
      lastLiveAt: NOW,
      history,
      withJournal: true,
    });
    // Join the in-flight startup pass before delaying history. A pending
    // Recovery retry still waits RECOVERY_RETRY_MIN_MS.
    await h.bridge.recover();

    let releaseRedeliver!: () => void;
    const holdRedeliver = new Promise<void>((resolve) => {
      releaseRedeliver = resolve;
    });
    let sawRedeliver!: () => void;
    const redeliverEntered = new Promise<void>((resolve) => {
      sawRedeliver = resolve;
    });
    const orig = h.channel.rawClient.im.v1.message.list;
    h.channel.rawClient.im.v1.message.list = async (params) => {
      sawRedeliver();
      await holdRedeliver;
      return orig(params);
    };

    h.channel.connectionState = 'reconnecting';
    await h.bridge.tickLink();
    const postedAt = now + 1_000;
    history[CHAT] = [mentionItem('om_mid_recover', CHAT, 'posted during outage', postedAt)];

    h.channel.connectionState = 'connected';
    // Step past the scan margin. One jump would be a suspend gap and would
    // wait for a new-socket frame before this reconnect can recover.
    const target = now + WATERMARK_MARGIN_MS + FEISHU_LINK_TICK_MS;
    while (now < target) {
      now += FEISHU_LINK_TICK_MS;
      await h.bridge.tickLink();
    }
    try {
      await redeliverEntered;
      expect(h.agent.runOptions).toHaveLength(0);
      await h.ledger.flush();
      const stopping = h.bridge.disconnect();
      releaseRedeliver();
      await stopping;
    } finally {
      releaseRedeliver();
    }

    const ledgerFile = h.ledger.getFilePath();
    const reloaded = new BackfillLedger(ledgerFile, { now: () => now });
    await reloaded.load();
    expect(reloaded.getLiveAt()!).toBeGreaterThan(postedAt + WATERMARK_MARGIN_MS);

    sdk.channel = createRecordingLarkChannel({
      botIdentity: { openId: BOT, name: 'Bot' },
      chats: [{ id: CHAT, name: 'Group' }],
      messagesByChat: history,
    });
    honorHistoryListWindow(sdk.channel, history);
    const second = await startChannel({
      cfg: h.cfg,
      agent: h.agent,
      sessions: h.sessions,
      workspaces: h.workspaces,
      ledger: reloaded,
      now: () => now,
      probe: async () => true,
      sleepProbe: notSleepingProbe(),
      controls: {
        profile: 'test',
        profileConfig: h.cfg,
        cfg: h.cfg,
        ownerRefreshState: 'ok',
        botOwnerId: USER,
        async refreshOwner() {},
        async restart() {},
        async exit() {},
        configPath: `${h.tmp.root}/config.json`,
        processId: 'test-feishu-link-restart',
      },
    });
    cleanups.push(async () => {
      await second.disconnect().catch(() => {});
    });
    await second.recover();
    await waitForDebounce();
    await until(() => h.agent.runOptions.some((opts) => opts.prompt.includes('posted during outage')));
    expect(h.agent.runOptions.filter((opts) => opts.prompt.includes('posted during outage'))).toHaveLength(1);
  });

  it('does not self-trigger recovery scans while one chat history stays 429', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval'] });
    const BAD = 'oc_bad';
    const OK = 'oc_ok';
    let lists = 0;
    let releaseOk!: () => void;
    const holdOk = new Promise<void>((resolve) => {
      releaseOk = resolve;
    });
    let holdingOk = true;
    await startHarness({
      now: () => NOW,
      probe: async () => true,
      lastLiveAt: NOW,
      history: { [BAD]: [], [OK]: [] },
      chats: [{ id: BAD, name: 'Bad' }, { id: OK, name: 'Ok' }],
      configureChannel(channel) {
        const orig = channel.rawClient.im.v1.message.list.bind(channel.rawClient.im.v1.message);
        channel.rawClient.im.v1.message.list = async (params: unknown) => {
          lists += 1;
          const nested = isRecord(params) && isRecord(params.params) ? params.params : isRecord(params) ? params : {};
          const chatId = typeof nested.container_id === 'string' ? nested.container_id : undefined;
          if (chatId === BAD) throw axiosHttpError(429);
          if (holdingOk && chatId === OK) await holdOk;
          return orig(params);
        };
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    for (let n = 0; lists < 2 && n < 20_000; n++) await yieldIO();
    expect(lists).toBeGreaterThanOrEqual(2);
    holdingOk = false;
    releaseOk();
    for (let i = 0; i < 40; i++) await yieldIO();
    const snapshot = lists;
    for (let i = 0; i < 40; i++) await yieldIO();
    expect(lists).toBe(snapshot);
  });
});

async function startHarness(opts: {
  now: () => number;
  probe: (signal?: AbortSignal) => Promise<boolean>;
  lastLiveAt: number;
  history: Record<string, unknown[]>;
  onRecovered?: (outage: { since: number; until: number }) => void;
  withJournal?: boolean;
  failHistory?: boolean;
  chats?: Array<{ id: string; name: string }>;
  configureChannel?: (channel: ReturnType<typeof createRecordingLarkChannel>) => void;
}) {
  const tmp = await createTmpProfile('feishu-link-recovery-');
  const ledger = new BackfillLedger(`${tmp.profile}/backfill-state.json`, { now: opts.now });
  await ledger.load();
  ledger.touchLive(opts.lastLiveAt);
  let journal: TurnJournal | undefined;
  if (opts.withJournal) {
    journal = new TurnJournal(`${tmp.profile}/turn-journal.json`, { now: opts.now });
    await journal.load();

  }
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], admins: [USER] },
    preferences: {
      messageReply: 'text',
      cotMessages: 'off',
      requireMentionInGroup: true,
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
    chats: opts.chats ?? [{ id: CHAT, name: 'Group' }],
    messagesByChat: opts.history,
  });
  if (opts.failHistory) channel.listChats = async () => { throw new Error('history unavailable'); };
  opts.configureChannel?.(channel);
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    ledger,
    ...(journal ? { journal } : {}),
    now: opts.now,
    probe: opts.probe,
    sleepProbe: notSleepingProbe(),
    ...(opts.onRecovered ? { onRecovered: opts.onRecovered } : {}),
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
      processId: 'test-feishu-link',
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, agent, ledger, bridge, journal, cfg, sessions, workspaces, tmp };
}

function mention(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: CHAT,
    chatType: 'group',
    senderId: USER,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime: NOW,
  } as unknown as NormalizedMessage;
}

function honorHistoryListWindow(
  channel: ReturnType<typeof createRecordingLarkChannel>,
  history: Record<string, unknown[]>,
): void {
  channel.rawClient.im.v1.message.list = async (params: unknown) => {
    const nested = isRecord(params) && isRecord(params.params) ? params.params : isRecord(params) ? params : {};
    const chatId = typeof nested.container_id === 'string' ? nested.container_id : undefined;
    const startSec = typeof nested.start_time === 'string' || typeof nested.start_time === 'number'
      ? Number(nested.start_time)
      : Number.NaN;
    const items = (chatId ? history[chatId] : undefined) ?? [];
    const filtered = Number.isFinite(startSec)
      ? items.filter((item) => {
          const created = Number((item as { create_time?: string | number }).create_time);
          return Number.isFinite(created) && created >= startSec * 1000;
        })
      : items;
    return { data: { items: filtered, has_more: false } };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mentionItem(
  messageId: string,
  chatId: string,
  text: string,
  createTime: number,
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
  };
}

async function waitForDebounce() {
  await new Promise((resolve) => setTimeout(resolve, 700));
}

/** Join a recovery transition already in flight. No wall-clock deadline. */
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 30; n++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await yieldIO();
  }
  throw new Error('expected FeishuLink recovery transition was not observed');
}

function notSleepingProbe(): {
  note(): void;
  detect(): Promise<{ suspended: false }>;
} {
  return {
    note() {},
    async detect() {
      return { suspended: false };
    },
  };
}
