import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import { FEISHU_LINK_SILENT_PROBE_MS, FEISHU_LINK_TICK_MS } from '../../../src/bot/feishu-link';
import { TurnJournal } from '../../../src/bot/turn-journal';
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

const BOT = 'ou_bot';
const USER = 'ou_user';
const CHAT = 'oc_group';
const NOW = 1_760_000_000_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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

  it('does not resend or backfill on connected ticks', async () => {
    let now = NOW;
    const h = await startHarness({
      now: () => now,
      probe: async () => true,
      lastLiveAt: NOW,
      history: { [CHAT]: [] },
    });
    await waitFor(() => h.ledger.getLiveAt() === NOW);
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
});

async function startHarness(opts: {
  now: () => number;
  probe: () => Promise<boolean>;
  lastLiveAt: number;
  history: Record<string, unknown[]>;
  onRecovered?: (outage: { since: number; until: number }) => void;
  withJournal?: boolean;
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
  return { channel, agent, ledger, bridge, journal };
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
