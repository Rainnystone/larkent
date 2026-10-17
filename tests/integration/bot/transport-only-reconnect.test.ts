import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannelOptions, NormalizedMessage } from '@larksuite/channel';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import { FEISHU_LINK_TICK_MS } from '../../../src/bot/feishu-link';
import type { AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
  options: undefined as LarkChannelOptions | undefined,
}));
vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: (opts: LarkChannelOptions) => {
    sdk.options = opts;
    return sdk.channel;
  },
}));
import { startChannel } from '../../../src/bot/channel';

const BOT = 'ou_bot';
const USER = 'ou_user';
const CHAT = 'oc_group';
const NOW = 1_760_000_000_000;
const ANSWER = 'still here after the blip';
const STUCK_MS = 60_000;
const DEBOUNCE_MS = 600;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
  sdk.options = undefined;
});

describe('transport-only WebSocket reconnect', () => {
  it('does not restart the bridge when the socket is stuck 60s with a healthy probe, and the active run replies once', async () => {
    let now = NOW;
    const restart = vi.fn(async () => {});
    const agent = new InFlightAgent();
    const h = await startHarness({ now: () => now, restart, agent });

    await h.channel.handlers.message?.(mention('om_run', 'please keep going'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await waitFor(() => agent.runOptions.length === 1);

    h.channel.connectionState = 'reconnecting';
    const stuckUntil = now + STUCK_MS;
    while (now < stuckUntil) {
      now += FEISHU_LINK_TICK_MS;
      await h.bridge.tickLink();
    }

    expect(sdk.options?.keepalive?.enabled).toBe(true);
    expect(sdk.options?.keepalive?.onUnrecoverable).toEqual(expect.any(Function));
    sdk.options?.keepalive?.onUnrecoverable?.(new Error('force-reconnect failed'));

    expect(restart).not.toHaveBeenCalled();
    expect(agent.stopped).toBe(false);
    expect(chatText(h.channel)).not.toContain('保活重启');

    h.channel.connectionState = 'connected';
    h.channel.emit('reconnected');
    now += FEISHU_LINK_TICK_MS;
    await h.bridge.tickLink();
    agent.releaseAnswer();

    await waitFor(() => chatText(h.channel).includes(ANSWER));
    expect(restart).not.toHaveBeenCalled();
    expect(agent.stopped).toBe(false);
    const replies = h.channel.snapshotCalls().filter((call) => call.op === 'send' || call.op === 'stream');
    expect(replies).toHaveLength(1);
    expect(chatText(h.channel)).toContain(ANSWER);
    expect(chatText(h.channel)).not.toContain('保活重启');
  });

  it('posts no 保活重启 notice after a proxy disconnect mid-run', async () => {
    let now = NOW;
    const restart = vi.fn(async () => {});
    const agent = new InFlightAgent();
    const h = await startHarness({ now: () => now, restart, agent });

    await h.channel.handlers.message?.(mention('om_run', 'please keep going'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await waitFor(() => agent.runOptions.length === 1);

    h.channel.connectionState = 'reconnecting';
    h.channel.emit('reconnecting');
    now += FEISHU_LINK_TICK_MS;
    await h.bridge.tickLink();

    h.channel.connectionState = 'connected';
    h.channel.emit('reconnected');
    now += FEISHU_LINK_TICK_MS;
    await h.bridge.tickLink();
    agent.releaseAnswer();

    expect(sdk.options?.keepalive?.enabled).toBe(true);
    sdk.options?.keepalive?.onUnrecoverable?.(new Error('proxy disconnect'));
    await waitFor(() => chatText(h.channel).includes(ANSWER));
    expect(restart).not.toHaveBeenCalled();
    expect(chatText(h.channel)).toContain(ANSWER);
    expect(chatText(h.channel)).not.toContain('保活重启');
    const replies = h.channel.snapshotCalls().filter((call) => call.op === 'send' || call.op === 'stream');
    expect(replies).toHaveLength(1);
  });
});

class InFlightAgent extends FakeAgentAdapter {
  stopped = false;
  readonly releaseAnswer: () => void;
  readonly #answerReady: Promise<void>;

  constructor() {
    let release!: () => void;
    const answerReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    super({ id: 'claude', waitForExit: true, hold: answerReady });
    this.releaseAnswer = release;
    this.#answerReady = answerReady;
  }

  override run(opts: AgentRunOptions): AgentRun {
    const recorded = super.run(opts);
    const answerReady = this.#answerReady;
    const agent = this;
    let markStopped = () => {};
    const stoppedAt = new Promise<void>((resolve) => {
      markStopped = resolve;
    });
    return {
      runId: recorded.runId,
      events: (async function* () {
        await Promise.race([answerReady, stoppedAt]);
        if (agent.stopped) return;
        yield { type: 'text', delta: ANSWER };
        yield { type: 'final_text', content: ANSWER };
        yield { type: 'done', terminationReason: 'normal' };
      })(),
      stop: async () => {
        agent.stopped = true;
        markStopped();
        await recorded.stop();
      },
      waitForExit: (timeoutMs) => recorded.waitForExit(timeoutMs),
    };
  }
}

async function startHarness(opts: {
  now: () => number;
  restart: () => Promise<void>;
  agent: InFlightAgent;
}) {
  const tmp = await createTmpProfile('transport-only-reconnect-');
  const ledger = new BackfillLedger(join(tmp.profile, 'backfill-state.json'), { now: opts.now });
  await ledger.load();
  ledger.touchLive(NOW);
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], admins: [USER] },
    preferences: {
      messageReply: 'text',
      cotMessages: 'off',
      requireMentionInGroup: true,
    },
    reliability: { notice: true },
  });
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const channel = createRecordingLarkChannel({
    botIdentity: { openId: BOT, name: 'Bot' },
    chats: [{ id: CHAT, name: 'Group' }],
    messagesByChat: { [CHAT]: [] },
  });
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent: opts.agent,
    sessions,
    workspaces,
    ledger,
    now: opts.now,
    probe: async () => true,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      ownerRefreshState: 'ok',
      botOwnerId: USER,
      async refreshOwner() {},
      restart: opts.restart,
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-transport-reconnect',
    },
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  cleanups.push(async () => {
    vi.useRealTimers();
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, bridge };
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

function chatText(channel: ReturnType<typeof createRecordingLarkChannel>): string {
  return JSON.stringify({
    sent: channel.sent,
    streams: channel.streams,
    calls: channel.snapshotCalls(),
  });
}

async function waitFor(predicate: () => boolean) {
  for (let n = 0; n < 10_000; n++) {
    if (predicate()) return;
    await yieldIO();
  }
  throw new Error('expected transport-only reconnect transition was not observed');
}
