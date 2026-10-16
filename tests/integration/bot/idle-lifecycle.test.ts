import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { ActiveRuns, type RunHandle } from '../../../src/bot/active-runs';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async importOriginal => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('bot idle and settlement lifecycle', () => {
  it('ends an unset-default run as idle_timeout after 15 minutes of silence and runs the queued message next', async () => {
    const h = await harness(false, 'unset');
    await h.channel.handlers.message?.(message('first', 'first request'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'WORKING' });
    await waitFor(() => rendered(h.channel).includes('WORKING'));
    await h.channel.handlers.message?.(message('second', 'queued request'));

    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(h.agent.runs[0]!.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => rendered(h.channel).includes('15 分钟无响应'));
    expect(h.agent.runs[0]!.stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    await drainIO();
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]!.prompt).toContain('queued request');
  });

  it('stops an open tool call at 60 minutes', async () => {
    const h = await harness(false, 'unset');
    await h.channel.handlers.message?.(message('first', 'please run the tool'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'tool_use', id: 'tool-1', name: 'long_tool', input: {} });
    await waitFor(() => rendered(h.channel).includes('long_tool'));

    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(h.agent.runs[0]!.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => rendered(h.channel).includes('60 分钟无响应'));
    expect(h.agent.runs[0]!.stopped).toBe(true);
  });

  it('disables the idle watchdog after /timeout 0', async () => {
    const h = await harness(false, 'unset');
    await h.channel.handlers.message?.(message('cmd', '/timeout 0'));
    await drainIO();

    await h.channel.handlers.message?.(message('first', 'first request'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'WORKING' });
    await waitFor(() => rendered(h.channel).includes('WORKING'));

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(h.agent.runs[0]!.stopped).toBe(false);
    expect(rendered(h.channel)).not.toContain('15 分钟无响应');
  });

  it('ends a blackholed model host run within 15 minutes and drains the queue', async () => {
    const h = await harness(false, 'unset');
    await h.channel.handlers.message?.(message('first', 'please talk to the model'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    await h.channel.handlers.message?.(message('second', 'queued after blackhole'));

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await waitFor(() => rendered(h.channel).includes('15 分钟无响应'));
    expect(h.agent.runs[0]!.stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    await drainIO();
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]!.prompt).toContain('queued after blackhole');
  });

  it('exposes lastEventAt on the run handle and advances it on stream events', async () => {
    const handles: RunHandle[] = [];
    const register = ActiveRuns.prototype.register;
    vi.spyOn(ActiveRuns.prototype, 'register').mockImplementation(function (
      this: ActiveRuns,
      chatId,
      run,
    ) {
      const handle = register.call(this, chatId, run);
      handles.push(handle);
      return handle;
    });

    const h = await harness(false, 'unset');
    await h.channel.handlers.message?.(message('first', 'first request'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => handles.length === 1);
    const handle = handles[0]!;
    expect(handle.lastEventAt).toEqual(expect.any(Number));
    const startedAt = handle.lastEventAt;

    await vi.advanceTimersByTimeAsync(1_000);
    h.agent.manual[0]!.push({ type: 'text', delta: 'WORKING' });
    await waitFor(() => rendered(h.channel).includes('WORKING'));
    expect(handle.lastEventAt).toBeGreaterThan(startedAt);
  });

  it('pauses idle for an in-flight tool then stops and publishes timeout after a full idle period', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(message('first', 'please run the tool'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'tool_use', id: 'tool-1', name: 'long_tool', input: {} });
    await waitFor(() => rendered(h.channel).includes('long_tool'));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.agent.runs[0]!.stopped).toBe(false);
    run.push({ type: 'tool_result', id: 'tool-1', output: 'TOOL_FINISHED', isError: false });
    await waitFor(() => rendered(h.channel).includes('TOOL_FINISHED'));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.agent.runs[0]!.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => rendered(h.channel).includes('超时'));
    expect(h.agent.runs[0]!.stopped).toBe(true);
  });

  it('keeps the next same-scope message queued until the previous stop and cleanup settle', async () => {
    const h = await harness(true);
    await h.channel.handlers.message?.(message('first', 'first request'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'FIRST_ANSWER' });
    await waitFor(() => rendered(h.channel).includes('FIRST_ANSWER'));
    await h.channel.handlers.message?.(message('second', 'second request'));
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => h.agent.runs[0]!.stopped);
    await vi.advanceTimersByTimeAsync(6000);
    await drainIO();
    expect(h.agent.runOptions).toHaveLength(1);

    run.releaseCleanup();
    await vi.advanceTimersByTimeAsync(0);
    await drainIO();
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]!.prompt).toContain('second request');
    const second = h.agent.manual[1]!;
    second.push({ type: 'text', delta: 'SECOND_ANSWER' });
    second.releaseCleanup();
    second.push({ type: 'done', terminationReason: 'normal' });
    second.close();
    await waitFor(() => rendered(h.channel).includes('SECOND_ANSWER'));
    expect(rendered(h.channel)).not.toContain('another run is already active');
  });
});

async function harness(holdCleanup = false, idleMinutes: number | 'unset' = 1) {
  const tmp = await createTmpProfile('idle-lifecycle-');
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: {
      messageReply: 'card',
      showToolCalls: true,
      cotMessages: 'off',
      ...(idleMinutes === 'unset' ? {} : { runIdleTimeoutMinutes: idleMinutes }),
    },
  });
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new StreamingFakeAgent(holdCleanup);
  const channel = createRecordingLarkChannel();
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg, agent, sessions, workspaces,
    controls: { profile: 'claude', profileConfig: cfg, cfg, ownerRefreshState: 'unknown',
      async refreshOwner() {}, async restart() {}, async exit() {},
      configPath: join(tmp.root, 'config.json'), processId: 'test-idle',
    },
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  cleanups.push(async () => {
    for (const run of agent.manual) run.releaseCleanup();
    await bridge.disconnect();
    await drainIO();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { channel, agent };
}

// FakeAgentAdapter records the run/stop contract; this controlled stream adds
// explicit event and cleanup readiness without real CLI or wall-clock sleeps.
class StreamingFakeAgent extends FakeAgentAdapter {
  readonly manual: ReturnType<typeof manualRun>[] = [];
  constructor(private readonly holdCleanup: boolean) { super({ id: 'claude' }); }
  override run(opts: AgentRunOptions): AgentRun {
    const recorded = super.run(opts);
    const manual = manualRun(recorded, this.holdCleanup);
    this.manual.push(manual);
    return manual.run;
  }
}

function manualRun(recorded: AgentRun, holdCleanup: boolean) {
  const queue: AgentEvent[] = [];
  let notify: (() => void) | undefined;
  let closed = false;
  let cleaned = false;
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = () => { cleaned = true; resolve(); }; });
  const close = () => { closed = true; notify?.(); };
  const run: AgentRun = {
    runId: recorded.runId,
    events: (async function* () {
      for (;;) {
        const event = queue.shift();
        if (event) { yield event; continue; }
        if (closed) return;
        await new Promise<void>(resolve => { notify = resolve; });
      }
    })(),
    stop: async () => {
      await recorded.stop();
      close();
      if (!holdCleanup) release();
      await cleanup;
    },
    waitForExit: async timeoutMs => {
      if (cleaned) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([cleanup.then(() => true), new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    },
  };
  return { run, close, releaseCleanup: release, push: (event: AgentEvent) => { queue.push(event); notify?.(); } };
}

function rendered(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return JSON.stringify({ sent: channel.sent, streams: channel.streams });
}

function message(messageId: string, content: string): NormalizedMessage {
  return { messageId, content, chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_user',
    senderName: 'User', rawContentType: 'text', resources: [], mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

async function drainIO() { for (let n = 0; n < 50; n++) await yieldIO(); }
async function waitFor(predicate: () => boolean) {
  // Timer progression remains explicit in each test; let real temporary-file
  // IO finish independently of the business-idle clock.
  for (let n = 0; n < 10_000; n++) {
    if (predicate()) return;
    await yieldIO();
  }
  throw new Error('expected lifecycle transition was not observed');
}
