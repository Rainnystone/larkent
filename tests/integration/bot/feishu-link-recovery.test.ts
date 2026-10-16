import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import { FEISHU_LINK_SILENT_PROBE_MS, FEISHU_LINK_TICK_MS } from '../../../src/bot/feishu-link';
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
}) {
  const tmp = await createTmpProfile('feishu-link-recovery-');
  const ledger = new BackfillLedger(`${tmp.profile}/backfill-state.json`, { now: opts.now });
  await ledger.load();
  ledger.touchLive(opts.lastLiveAt);
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
  return { channel, agent, ledger, bridge };
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
