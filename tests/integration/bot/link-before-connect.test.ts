import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import { CONTINUE_HINT } from '../../../src/bot/interruption-notice';
import { TurnJournal } from '../../../src/bot/turn-journal';
import type { BridgeChannel } from '../../../src/bot/channel';
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
const OWNER = 'ou_owner';
const CHAT = 'oc_group';
const NOW = 1_760_000_000_000;
const REST_DEADLINE_MS = 80;
const DEBOUNCE_MS = 600;
const UNKNOWN_STDERR = [
  'failed to read /Users/someone/.cursor/projects/secret-repo/config.json',
  'account: user@example.com',
].join('\n');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('T14 link and REST intake before connect', { timeout: 20_000 }, () => {
  it('answers the first @ on a fresh bridge exactly once after a REST connect hang recovers', async () => {
    const rest = hangingRest();
    const recovered: Array<{ since: number; until: number }> = [];
    const history: Record<string, unknown[]> = { [CHAT]: [] };
    const h = await startHarness({
      rest,
      probe: async () => rest.up,
      lastLiveAt: NOW,
      history,
      outboundTimeoutMs: REST_DEADLINE_MS,
      onRecovered: (outage) => {
        recovered.push(outage);
      },
    });

    const postedAt = NOW - 30_000;
    history[CHAT] = [mentionItem('om_first', 'hello during rest outage', postedAt)];
    void h.channel.handlers.message?.(mention('om_first', 'hello during rest outage', postedAt));
    await sleep(REST_DEADLINE_MS + 40);

    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.ledger.has('om_first')).toBe(false);
    expect(answerSends(h.channel)).toHaveLength(0);

    rest.up = true;
    await h.bridge.tickLink();
    await waitForDebounce();
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]!.prompt).toContain('hello during rest outage');
    expect(answerSends(h.channel)).toHaveLength(1);
    expect(recovered.length).toBeGreaterThanOrEqual(1);
  });

  it('records a startup reply id so its echo is not a CLI self-send', async () => {
    const owner = deferredAppInfo();
    try {
      const h = await startHarness({
        holdAppInfo: owner.promise,
        probe: async () => true,
        lastLiveAt: NOW,
        history: { [CHAT]: [] },
        replyMode: 'markdown',
        streaming: true,
      });
      await h.channel.handlers.message?.(mention('om_startup', 'please answer now'));
      await waitForDebounce();
      await waitFor(() => (h.agent as StreamingFakeAgent).manual.length === 1);
      const run = (h.agent as StreamingFakeAgent).manual[0]!;
      run.push({ type: 'text', delta: 'late answer' });
      await waitFor(() => h.channel.streams.length === 1);
      const stream = h.channel.streams[0]!;
      expect(stream.messageId).toMatch(/^om_/);

      await h.channel.handlers.message?.(selfEcho(stream.messageId, 'late answer'));
      run.push({ type: 'done', terminationReason: 'normal' });
      run.close();
      run.releaseCleanup();
      await waitFor(() => stream.markdownContents.some((text) => text.includes('late answer')));

      expect(h.channel.streams).toHaveLength(1);
      expect(stream.markdownContents.some((text) => text.includes('late answer'))).toBe(true);
      expect(h.journal.list().some((entry) => entry.cliAlreadySent === true)).toBe(false);
    } finally {
      owner.resolve();
    }
  });

  it('reports an outage overlap for a run that started during startup', async () => {
    const owner = deferredAppInfo();
    try {
      const h = await startHarness({
        holdAppInfo: owner.promise,
        probe: async () => true,
        lastLiveAt: NOW,
        history: { [CHAT]: [] },
        replyMode: 'card',
        streaming: true,
      });
      await h.channel.handlers.message?.(mention('om_overlap', 'please run'));
      await waitForDebounce();
      await waitFor(() => (h.agent as StreamingFakeAgent).manual.length === 1);
      const run = (h.agent as StreamingFakeAgent).manual[0]!;
      run.push({ type: 'text', delta: 'WORKING' });
      await waitFor(() => JSON.stringify(h.channel.streams).includes('WORKING'));

      owner.resolve();
      await h.started;

      h.channel.connectionState = 'reconnecting';
      await h.bridge.tickLink();
      run.stderrSnapshot = UNKNOWN_STDERR;
      run.push({
        type: 'error',
        message: `cursor exited with code 1: ${UNKNOWN_STDERR}`,
        terminationReason: 'failed',
      });
      run.close();
      run.releaseCleanup();
      h.channel.connectionState = 'connected';
      await h.bridge.tickLink();
      await waitFor(() => noticeCards(h.channel).length === 1);

      const notice = JSON.stringify(noticeCards(h.channel)[0]?.content);
      expect(notice).toContain('上游网络中断');
      expect(notice).toContain('notice.continue');
      expect(notice).toContain(CONTINUE_HINT);
    } finally {
      owner.resolve();
    }
  });

  it('recovers exactly once on startup and exactly once on supervisor swap', async () => {
    const recovered: Array<{ since: number; until: number }> = [];
    const first = await startHarness({
      probe: async () => true,
      lastLiveAt: NOW,
      history: { [CHAT]: [] },
      onRecovered: (outage) => {
        recovered.push(outage);
      },
    });
    await waitFor(() => recovered.length === 1);
    expect(recovered).toHaveLength(1);
    await first.bridge.disconnect();

    sdk.channel = first.channel;
    const second = await startChannel({
      cfg: first.cfg,
      agent: first.agent,
      sessions: first.sessions,
      workspaces: first.workspaces,
      ledger: first.ledger,
      probe: async () => true,
      onRecovered: (outage) => {
        recovered.push(outage);
      },
      controls: first.controls,
    });
    cleanups.push(async () => {
      await second.disconnect().catch(() => {});
    });
    await waitFor(() => recovered.length === 2);
    expect(recovered).toHaveLength(2);
  });
});

function hangingRest(): {
  up: boolean;
  connect(): Promise<void>;
  abort(): void;
} {
  const waiters: Array<(err?: Error) => void> = [];
  return {
    up: false,
    connect() {
      if (this.up) return Promise.resolve();
      return new Promise((_, reject) => {
        waiters.push(reject);
      });
    },
    abort() {
      const err = new Error('test rest connect aborted');
      for (const reject of waiters.splice(0)) reject(err);
    },
  };
}

function deferredAppInfo(): { promise: Promise<{ ownerId: string }>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<{ ownerId: string }>((ok) => {
    resolve = () => ok({ ownerId: OWNER });
  });
  return { promise, resolve };
}

interface Harness {
  channel: ReturnType<typeof createRecordingLarkChannel>;
  agent: FakeAgentAdapter;
  ledger: BackfillLedger;
  journal: TurnJournal;
  bridge: BridgeChannel;
  started: Promise<BridgeChannel>;
  cfg: ReturnType<typeof createDefaultProfileConfig>;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Parameters<typeof startChannel>[0]['controls'];
}

async function startHarness(opts: {
  rest?: { up: boolean; connect(): Promise<void>; abort(): void };
  holdAppInfo?: Promise<{ ownerId: string }>;
  probe: (signal?: AbortSignal) => Promise<boolean>;
  lastLiveAt: number;
  history: Record<string, unknown[]>;
  outboundTimeoutMs?: number;
  onRecovered?: (outage: { since: number; until: number }) => void;
  replyMode?: 'text' | 'markdown' | 'card';
  streaming?: boolean;
}): Promise<Harness> {
  const tmp = await createTmpProfile('link-before-connect-');
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  const ledger = new BackfillLedger(`${tmp.profile}/backfill-state.json`);
  await ledger.load();
  ledger.touchLive(opts.lastLiveAt);
  const journal = new TurnJournal(`${tmp.profile}/turn-journal.json`);
  await journal.load();
  const cfg = createDefaultProfileConfig({
    agentKind: opts.streaming ? 'cursor' : 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], allowedChats: [CHAT], admins: [USER] },
    preferences: {
      messageReply: opts.replyMode ?? 'text',
      cotMessages: 'off',
      requireMentionInGroup: true,
      showToolCalls: true,
    },
    reliability: { notice: true },
  });
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const agent = opts.streaming
    ? new StreamingFakeAgent('cursor')
    : new FakeAgentAdapter({
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
  if (opts.rest) {
    const rest = opts.rest;
    channel.getChatMode = async () => {
      await rest.connect();
      return 'group';
    };
    cleanups.push(async () => {
      rest.abort();
    });
  }
  if (opts.holdAppInfo) {
    channel.getAppInfo = async () => opts.holdAppInfo!;
  }
  sdk.channel = channel;
  const controls = {
    profile: 'test',
    profileConfig: cfg,
    cfg,
    ownerRefreshState: 'ok' as const,
    botOwnerId: USER,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.root}/config.json`,
    processId: 'test-link-before-connect',
  };
  const started = startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    ledger,
    journal,
    now: () => NOW,
    probe: opts.probe,
    ...(opts.outboundTimeoutMs !== undefined ? { outboundTimeoutMs: opts.outboundTimeoutMs } : {}),
    ...(opts.onRecovered ? { onRecovered: opts.onRecovered } : {}),
    appPaths: {
      mediaDir,
      secretsFile: join(tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(tmp.profile, '.keystore.salt'),
    },
    controls,
  });
  cleanups.push(async () => {
    const bridge = await started.catch(() => undefined);
    await bridge?.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  await waitFor(() => Boolean(channel.handlers.message));
  const bridge = opts.holdAppInfo
    ? {
      channel,
      tickLink: () => started.then((next) => next.tickLink()),
      disconnect: () => started.then((next) => next.disconnect()),
      recover: (outage?: Parameters<BridgeChannel['recover']>[0]) => started.then((next) => next.recover(outage)),
      recoverMissed: (outage?: Parameters<BridgeChannel['recoverMissed']>[0]) => (
        started.then((next) => next.recoverMissed(outage))
      ),
    } as unknown as BridgeChannel
    : await started;
  return { channel, agent, ledger, journal, bridge, started, cfg, sessions, workspaces, controls };
}

function mention(messageId: string, content: string, createTime = NOW): NormalizedMessage {
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
    createTime,
    mentions: [],
    mentionAll: false,
  } as unknown as NormalizedMessage;
}

function selfEcho(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: CHAT,
    chatType: 'group',
    senderId: BOT,
    senderName: 'Bot',
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: NOW,
    raw: { sender: { sender_type: 'app' } },
  } as unknown as NormalizedMessage;
}

function mentionItem(messageId: string, text: string, createTime: number): Record<string, unknown> {
  return {
    message_id: messageId,
    chat_id: CHAT,
    msg_type: 'text',
    create_time: String(createTime),
    deleted: false,
    sender: { id: USER, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `@_user_1 ${text}` }) },
    mentions: [{ key: '@_user_1', id: BOT, id_type: 'open_id', name: 'Bot' }],
  };
}

function answerSends(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return channel.snapshotCalls().filter((call) => call.op === 'send' || call.op === 'stream');
}

function noticeCards(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return channel.sent.filter((item) => {
    const json = JSON.stringify(item.content);
    return json.includes('notice.continue') || json.includes(CONTINUE_HINT);
  });
}

class StreamingFakeAgent extends FakeAgentAdapter {
  readonly manual: ReturnType<typeof manualRun>[] = [];
  constructor(id: string) {
    super({ id });
  }

  override run(opts: AgentRunOptions): AgentRun {
    const recorded = super.run(opts);
    const manual = manualRun(recorded);
    this.manual.push(manual);
    return manual.run;
  }
}

function manualRun(recorded: AgentRun) {
  const queue: AgentEvent[] = [];
  let notify: (() => void) | undefined;
  let closed = false;
  let cleaned = false;
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = () => {
      cleaned = true;
      resolve();
    };
  });
  const run: AgentRun & { stderrSnapshot?: string } = {
    runId: recorded.runId,
    events: (async function* () {
      for (;;) {
        const event = queue.shift();
        if (event) {
          yield event;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    })(),
    stop: async () => {
      await recorded.stop();
      release();
      await cleanup;
    },
    waitForExit: async (timeoutMs) => {
      if (cleaned) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          cleanup.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
  return {
    run,
    close: () => {
      closed = true;
      notify?.();
    },
    releaseCleanup: release,
    push: (event: AgentEvent) => {
      queue.push(event);
      notify?.();
    },
    set stderrSnapshot(value: string) {
      run.stderrSnapshot = value;
    },
  };
}

async function waitForDebounce() {
  await sleep(DEBOUNCE_MS + 50);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean) {
  for (let n = 0; n < 10_000; n++) {
    if (predicate()) return;
    await yieldIO();
  }
  throw new Error('expected T14 transition was not observed');
}
