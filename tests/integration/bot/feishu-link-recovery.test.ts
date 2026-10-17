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

    await waitFor(() => recovered.length === 1);
    // Startup recover is fire-and-forget after the first tick. Join it
    // (or retry immediately if that pass was incomplete) before the
    // silent-probe clock starts, or lastEvidenceAt jumps and the outage
    // window starts after failureStart.
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
    await waitFor(() => recovered.length === 1);
    expect(recovered[0]!.since).toBeLessThanOrEqual(failureStart);

    await waitForDebounce();
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]!.prompt).toContain('missed while REST was down');
    const replies = h.channel.snapshotCalls().filter((call) => call.op === 'send' || call.op === 'stream');
    expect(replies).toHaveLength(1);
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
    await waitFor(() => h.ledger.getLiveAt() === NOW);
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
    await waitFor(() => h.journal!.get('turn-staged')?.status === 'reply-delivered');
    expect(stagedSends()).toHaveLength(1);

    await h.bridge.recover();
    expect(stagedSends()).toHaveLength(1);

    h.channel.connectionState = 'reconnecting';
    await h.bridge.tickLink();
    h.channel.connectionState = 'connected';
    await h.bridge.tickLink();
    await waitForDebounce();
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
    await waitFor(() => h.ledger.getLiveAt() === NOW);
    await h.bridge.recover();

    const orig = h.journal!.redeliver.bind(h.journal);
    // Stay failing across Recovery + the post-recover outbox sweep. Clearing
    // the flag inside the first throw lets sweep send before the retry recover.
    let boom = true;
    h.journal!.redeliver = async (opts) => {
      if (boom) {
        throw new Error('ENOSPC journal persist');
      }
      return orig(opts);
    };

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
    const stagedSends = () => h.channel.sent.filter((item) =>
      JSON.stringify(item.content).includes('FLUSH_RETRY'),
    );

    await h.bridge.recover({ since: NOW - 1_000, until: NOW, hostSuspended: false });
    expect(stagedSends()).toHaveLength(0);
    expect(fail.mock.calls.some((call) => call[0] === 'recovery')).toBe(true);

    boom = false;
    await h.bridge.recover({ since: NOW - 1_000, until: NOW, hostSuspended: false });
    await waitFor(() => stagedSends().length === 1);
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
        boomRedeliver: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections, String(rejections[0])).toEqual([]);
      expect(fail.mock.calls.some((call) => call[0] === 'recovery')).toBe(true);

      await h.channel.handlers.message?.(mention('om_live', 'still listening'));
      await waitForDebounce();
      await waitFor(() => h.agent.runOptions.length === 1);
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
    await waitFor(() => h.ledger.getLiveAt() === NOW);
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

  it('backfills an outage after shutdown between recover and backfill', async () => {
    let now = NOW;
    const history: Record<string, unknown[]> = { [CHAT]: [] };
    const h = await startHarness({
      now: () => now,
      probe: async () => true,
      lastLiveAt: NOW,
      history,
      withJournal: true,
    });
    // waitFor is 10k setImmediate turns and cannot see Recovery's 1s
    // retry after an incomplete startup scan. Join the in-flight pass
    // (or retry immediately) before wrapping redeliver.
    await h.bridge.recover();

    let releaseRedeliver!: () => void;
    const holdRedeliver = new Promise<void>((resolve) => {
      releaseRedeliver = resolve;
    });
    const orig = h.journal!.redeliver.bind(h.journal);
    let redeliverStarted = false;
    h.journal!.redeliver = async (opts) => {
      redeliverStarted = true;
      await holdRedeliver;
      return orig(opts);
    };

    h.channel.connectionState = 'reconnecting';
    await h.bridge.tickLink();
    const postedAt = now + 1_000;
    history[CHAT] = [mentionItem('om_mid_recover', CHAT, 'posted during outage', postedAt)];

    h.channel.connectionState = 'connected';
    // Advance past the 2-minute scan margin so a restart that only has the
    // new lastLiveAt cannot still see this message.
    now += WATERMARK_MARGIN_MS + FEISHU_LINK_TICK_MS;
    await h.bridge.tickLink();
    await waitFor(() => redeliverStarted);
    expect(h.agent.runOptions).toHaveLength(0);
    await h.ledger.flush();

    const ledgerFile = h.ledger.getFilePath();
    const stopping = h.bridge.disconnect();
    releaseRedeliver();
    await stopping;

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
    await waitFor(() => h.agent.runOptions.some((opts) => opts.prompt.includes('posted during outage')));
    expect(h.agent.runOptions.filter((opts) => opts.prompt.includes('posted during outage'))).toHaveLength(1);
  });
});

async function startHarness(opts: {
  now: () => number;
  probe: (signal?: AbortSignal) => Promise<boolean>;
  lastLiveAt: number;
  history: Record<string, unknown[]>;
  onRecovered?: (outage: { since: number; until: number }) => void;
  withJournal?: boolean;
  boomRedeliver?: boolean;
}) {
  const tmp = await createTmpProfile('feishu-link-recovery-');
  const ledger = new BackfillLedger(`${tmp.profile}/backfill-state.json`, { now: opts.now });
  await ledger.load();
  ledger.touchLive(opts.lastLiveAt);
  let journal: TurnJournal | undefined;
  if (opts.withJournal) {
    journal = new TurnJournal(`${tmp.profile}/turn-journal.json`, { now: opts.now });
    await journal.load();
    if (opts.boomRedeliver) {
      journal.redeliver = async () => {
        throw new Error('ENOSPC journal persist');
      };
    }
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
    chats: [{ id: CHAT, name: 'Group' }],
    messagesByChat: opts.history,
  });
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

async function waitFor(predicate: () => boolean) {
  for (let n = 0; n < 10_000; n++) {
    if (predicate()) return;
    await yieldIO();
  }
  throw new Error('expected FeishuLink recovery transition was not observed');
}
