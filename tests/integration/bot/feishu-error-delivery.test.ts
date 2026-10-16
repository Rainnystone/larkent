import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { STALL_AFTER_RECOVERY_MS } from '../../../src/bot/recovery';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import {
  axiosErrno,
  axiosHttpError,
  sdkShapedSendError,
} from '../../helpers/sdk-feishu-errors';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
}));
vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const USER = 'ou_user';
const STREAM_CHAT = 'oc_stream';
const TOOL_CHAT = 'oc_tool';
const TEXT_CHAT = 'oc_text';
const ANSWER = 'T11_FINAL_ANSWER';
const NOW = 1_760_000_000_000;
const STREAM_MS = 5 * 60_000;
// Keep in lockstep with STREAM_TERMINAL_GRACE_MS in src/bot/channel.ts.
const STREAM_TERMINAL_GRACE_MS = 3_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('one classifier and untimed stream', { timeout: 20_000 }, () => {
  it('lets a 5-minute streamed run finish without an outage, recovery, or stalling a tool-call in another chat', async () => {
    const recovered: Array<{ since: number; until: number }> = [];
    const h = await streamHarness({ onRecovered: (outage) => recovered.push(outage) });
    recovered.length = 0;

    await h.channel.handlers.message?.(p2p(TOOL_CHAT, 'om_tool', 'run a long tool'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const toolRun = h.agent.manual[0]!;
    toolRun.push({ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 600' } });
    await waitFor(() => rendered(h.channel).includes('Bash') || rendered(h.channel).includes('⏳'));

    await h.channel.handlers.message?.(p2p(STREAM_CHAT, 'om_stream', 'write a long reply'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 2);
    const streamRun = h.agent.manual[1]!;
    streamRun.push({ type: 'text', delta: 'WORKING' });
    await waitFor(() => rendered(h.channel).includes('WORKING'));

    await vi.advanceTimersByTimeAsync(STREAM_MS);
    await drainIO();
    await h.bridge.tickLink();
    expect(recovered).toHaveLength(0);
    expect(toolRun.run.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(STALL_AFTER_RECOVERY_MS);
    await drainIO();
    await h.bridge.tickLink();
    expect(recovered).toHaveLength(0);
    expect(toolRun.run.stopped).toBe(false);
    expect(rendered(h.channel)).not.toContain('2 分钟无响应');

    streamRun.push({ type: 'done', terminationReason: 'normal' });
    streamRun.close();
    streamRun.releaseCleanup();
    await drainIO();
    await vi.advanceTimersByTimeAsync(STREAM_TERMINAL_GRACE_MS);
    await drainIO();
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_stream') && entry.status === 'reply-delivered'
    )));
    const streamTurn = h.journal.list().find((entry) => entry.messageIds.includes('om_stream'));
    expect(streamTurn?.outcome).toMatchObject({ kind: 'completed' });
    expect(streamTurn?.outcome).not.toMatchObject({ cause: 'transient-upstream' });
  });

  it('keeps the link up on a staged 403 and posts exactly one fallback without a recovery loop', async () => {
    const recovered: Array<{ since: number; until: number }> = [];
    const fail = { err: undefined as unknown };
    const h = await textHarness({ fail, onRecovered: (outage) => recovered.push(outage) });
    recovered.length = 0;
    fail.err = sdkShapedSendError('permission_denied', axiosHttpError(403, 'Bot is not in the chat'));

    await h.channel.handlers.message?.(p2p(TEXT_CHAT, 'om_403', 'please answer'));
    await waitFor(() => answerSends(h.channel).length === 1);
    expect(answerSends(h.channel)).toHaveLength(1);
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain(ANSWER);
    expect(h.journal.list().some((entry) => (
      entry.messageIds.includes('om_403') && entry.status === 'reply-delivered'
    ))).toBe(true);

    await h.bridge.tickLink();
    await h.bridge.tickLink();
    expect(recovered).toHaveLength(0);
    expect(answerSends(h.channel)).toHaveLength(1);
  });

  it('does not retry an ENETUNREACH final send until recovery delivers it once', async () => {
    const fail = { err: undefined as unknown };
    const h = await textHarness({ fail });
    fail.err = sdkShapedSendError(
      'unknown',
      axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'),
    );

    await h.channel.handlers.message?.(p2p(TEXT_CHAT, 'om_net', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_net') && entry.status === 'completed-undelivered'
    )));
    expect(answerSends(h.channel)).toHaveLength(0);

    await h.bridge.recoverMissed();
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_net') && entry.status === 'reply-delivered'
    )));
    expect(answerSends(h.channel)).toHaveLength(1);

    await h.bridge.recoverMissed();
    expect(answerSends(h.channel)).toHaveLength(1);
  });
});

async function streamHarness(opts: {
  onRecovered: (outage: { since: number; until: number }) => void;
}) {
  const tmp = await createTmpProfile('t11-stream-');
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'));
  await journal.load();
  const cfg = profile(tmp.workspace, 'card');
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new StreamingFakeAgent();
  const channel = createRecordingLarkChannel();
  sdk.channel = channel;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    journal,
    now: () => Date.now(),
    probe: async () => true,
    onRecovered: opts.onRecovered,
    appPaths: {
      mediaDir,
      secretsFile: join(tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(tmp.profile, '.keystore.salt'),
    },
    controls: controls(cfg, tmp, 'test-t11-stream'),
  });
  cleanups.push(async () => {
    for (const run of agent.manual) run.releaseCleanup();
    await bridge.disconnect();
    await drainIO();
    await tmp.cleanup();
  });
  return { channel, agent, bridge, journal };
}

async function textHarness(opts: {
  fail: { err: unknown };
  onRecovered?: (outage: { since: number; until: number }) => void;
}) {
  const tmp = await createTmpProfile('t11-text-');
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'));
  await journal.load();
  const cfg = profile(tmp.workspace, 'text');
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'claude',
    events: [[{
      type: 'text',
      delta: ANSWER,
    }, {
      type: 'final_text',
      content: ANSWER,
    }, {
      type: 'done',
      terminationReason: 'normal',
      resumeHandle: 'sess-1',
    }]],
  });
  const channel = createRecordingLarkChannel();
  const origSend = channel.send.bind(channel);
  channel.send = async (...args: Parameters<typeof origSend>) => {
    if (opts.fail.err !== undefined) {
      const err = opts.fail.err;
      opts.fail.err = undefined;
      throw err;
    }
    return origSend(...args);
  };
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    journal,
    probe: async () => true,
    ...(opts.onRecovered ? { onRecovered: opts.onRecovered } : {}),
    controls: controls(cfg, tmp, 'test-t11-text'),
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, bridge, journal };
}

function profile(workspace: string, replyMode: 'text' | 'card') {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER] },
    preferences: {
      messageReply: replyMode,
      messageReplyMigrated: true,
      showToolCalls: true,
      cotMessages: 'off',
    },
  });
  cfg.workspaces.default = workspace;
  return cfg;
}

function controls(
  cfg: ReturnType<typeof profile>,
  tmp: { root: string },
  processId: string,
) {
  return {
    profile: 'claude',
    profileConfig: cfg,
    cfg,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: join(tmp.root, 'config.json'),
    processId,
  };
}

class StreamingFakeAgent extends FakeAgentAdapter {
  readonly manual: ReturnType<typeof manualRun>[] = [];
  constructor() { super({ id: 'claude' }); }
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
  const close = () => {
    closed = true;
    notify?.();
  };
  const run: AgentRun & { stopped: boolean } = {
    runId: recorded.runId,
    stopped: false,
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
      run.stopped = true;
      await recorded.stop();
      close();
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
    close,
    releaseCleanup: release,
    push: (event: AgentEvent) => {
      queue.push(event);
      notify?.();
    },
  };
}

function p2p(chatId: string, messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    content,
    chatId,
    chatType: 'p2p',
    senderId: USER,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: Date.now(),
  } as unknown as NormalizedMessage;
}

function answerSends(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return channel.sent.filter((item) => JSON.stringify(item.content).includes(ANSWER));
}

function rendered(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return JSON.stringify({ sent: channel.sent, streams: channel.streams });
}

async function drainIO() {
  for (let n = 0; n < 50; n++) await yieldIO();
}

async function waitFor(predicate: () => boolean) {
  // Timer progression stays explicit at the call site. Fake Date is the
  // business clock, not a wait deadline — advancing it here raced stream
  // grace against delivery on ubuntu/windows CI.
  if (vi.isFakeTimers()) {
    for (let n = 0; n < 10_000; n++) {
      if (predicate()) return;
      await yieldIO();
    }
  } else {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('expected T11 delivery transition was not observed');
}
