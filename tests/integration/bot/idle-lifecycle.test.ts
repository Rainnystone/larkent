import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { ActiveRuns, type RunHandle } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
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
    await h.waitForRun(1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'WORKING' });
    await waitFor(() => rendered(h.channel).includes('WORKING'));
    await h.channel.handlers.message?.(message('second', 'queued request'));

    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(h.agent.runs[0]!.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await h.unblocked.waitFor(1);
    expect(rendered(h.channel)).toContain('15 分钟无响应');
    expect(h.agent.runs[0]!.stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(2);
    expect(h.agent.runOptions[1]!.prompt).toContain('queued request');
  });

  it('stops an open tool call at 60 minutes', async () => {
    const h = await harness(false, 'unset');
    await h.channel.handlers.message?.(message('first', 'please run the tool'));
    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'tool_use', id: 'tool-1', name: 'long_tool', input: {} });
    await waitFor(() => rendered(h.channel).includes('long_tool'));

    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(h.agent.runs[0]!.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await h.unblocked.waitFor(1);
    expect(rendered(h.channel)).toContain('60 分钟无响应');
    expect(h.agent.runs[0]!.stopped).toBe(true);
  });

  it('disables the idle watchdog after /timeout 0', async () => {
    const h = await harness(false, 'unset');
    await h.channel.handlers.message?.(message('cmd', '/timeout 0'));
    await drainIO();

    await h.channel.handlers.message?.(message('first', 'first request'));
    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(1);
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
    await h.waitForRun(1);
    await h.channel.handlers.message?.(message('second', 'queued after blackhole'));

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await h.unblocked.waitFor(1);
    expect(rendered(h.channel)).toContain('15 分钟无响应');
    expect(h.agent.runs[0]!.stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(2);
    expect(h.agent.runOptions[1]!.prompt).toContain('queued after blackhole');
  });

  it('pauses idle for an in-flight tool then stops and publishes timeout after a full idle period', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(message('first', 'please run the tool'));
    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(1);
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
    await h.unblocked.waitFor(1);
    expect(rendered(h.channel)).toContain('超时');
    expect(h.agent.runs[0]!.stopped).toBe(true);
  });

  it('waits for delayed preparation without consuming the idle clock', async () => {
    const h = await harness();
    const preparing = deferred();
    const release = deferred();
    h.agent.prepareRun = async () => { preparing.resolve(); await release.promise; };
    try {
      await h.channel.handlers.message?.(message('first', 'delayed preparation'));
      await vi.advanceTimersByTimeAsync(600);
      await preparing.promise;
      const idleClock = Date.now();
      let started = false;
      const ready = h.waitForRun(1).then(() => { started = true; });
      void ready.catch(() => {});
      // Exceed the old spin limit while preparation remains deliberately held.
      for (let n = 0; n < 20_000; n++) await yieldIO();
      expect(started).toBe(false);
      expect(Date.now()).toBe(idleClock);
      release.resolve();
      await ready;
      expect(h.agent.manual).toHaveLength(1);
      expect(Date.now()).toBe(idleClock);
    } finally { release.resolve(); }
  });

  it('waits for timeout publication to settle before advancing queued debounce', async () => {
    const h = await harness(false, 'unset');
    const publishing = deferred();
    const release = deferred();
    const send = h.channel.send.bind(h.channel);
    vi.spyOn(h.channel, 'send').mockImplementation(async (...args) => {
      const receipt = await send(...args);
      if (JSON.stringify(args[1]).includes('15 分钟无响应')) {
        publishing.resolve();
        await release.promise;
      }
      return receipt;
    });
    try {
      await h.channel.handlers.message?.(message('first', 'blackholed request'));
      await vi.advanceTimersByTimeAsync(600);
      await h.waitForRun(1);
      await h.channel.handlers.message?.(message('second', 'queued after publication'));
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await publishing.promise;
      expect(rendered(h.channel)).toContain('15 分钟无响应');
      expect(h.agent.runs[0]!.stopped).toBe(true);

      let unblocked = false;
      const ready = h.unblocked.waitFor(1).then(() => { unblocked = true; });
      const idleClock = Date.now();
      await drainIO();
      expect(unblocked).toBe(false);
      expect(h.agent.runOptions).toHaveLength(1);
      release.resolve();
      await ready;
      expect(Date.now()).toBe(idleClock);
      await vi.advanceTimersByTimeAsync(599);
      expect(h.agent.runOptions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await h.waitForRun(2);
      expect(h.agent.runOptions[1]!.prompt).toContain('queued after publication');
    } finally { release.resolve(); }
  });

  it('keeps the next same-scope message queued until the previous stop and cleanup settle', async () => {
    const h = await harness(true);
    await h.channel.handlers.message?.(message('first', 'first request'));
    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'FIRST_ANSWER' });
    await waitFor(() => rendered(h.channel).includes('FIRST_ANSWER'));
    await h.channel.handlers.message?.(message('second', 'second request'));
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    await run.waitingForExit;
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => h.agent.runs[0]!.stopped);
    await vi.advanceTimersByTimeAsync(6000);
    await drainIO();
    expect(h.agent.runOptions).toHaveLength(1);

    run.releaseCleanup();
    await h.unblocked.waitFor(1);
    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(2);
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
  const handles: RunHandle[] = [];
  const register = ActiveRuns.prototype.register;
  vi.spyOn(ActiveRuns.prototype, 'register').mockImplementation(function (this: ActiveRuns, scope, run) {
    const handle = register.call(this, scope, run);
    handles.push(handle);
    return handle;
  });
  const unblocked = checkpoints();
  const unblock = PendingQueue.prototype.unblock;
  vi.spyOn(PendingQueue.prototype, 'unblock').mockImplementation(function (this: PendingQueue, scope) {
    const wasBlocked = this.isBlocked(scope);
    unblock.call(this, scope);
    if (wasBlocked) unblocked.complete();
  });
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
  return {
    channel, agent, unblocked,
    async waitForRun(count: number) {
      // Agent setup can await real filesystem/transport IO. Its completion is
      // not bounded by a count of event-loop turns or by the fake idle clock.
      await agent.started.waitFor(count);
      expect(agent.manual).toHaveLength(count);
      // Registration and watchdog setup follow run() in in-process promises.
      await waitFor(() => handles[count - 1]?.armStallDeadline !== undefined);
    },
  };
}

// FakeAgentAdapter records the run/stop contract; this controlled stream adds
// explicit event and cleanup readiness without real CLI or wall-clock sleeps.
class StreamingFakeAgent extends FakeAgentAdapter {
  readonly manual: ReturnType<typeof manualRun>[] = [];
  readonly started = checkpoints();
  async prepareRun(): Promise<void> {}
  constructor(private readonly holdCleanup: boolean) { super({ id: 'claude' }); }
  override run(opts: AgentRunOptions): AgentRun {
    const recorded = super.run(opts);
    const manual = manualRun(recorded, this.holdCleanup);
    this.manual.push(manual);
    this.started.complete();
    return manual.run;
  }
}

function manualRun(recorded: AgentRun, holdCleanup: boolean) {
  const queue: AgentEvent[] = [];
  const waitingForExit = deferred();
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
        const exited = Promise.race([cleanup.then(() => true), new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        })]);
        waitingForExit.resolve();
        return await exited;
      } finally { if (timer) clearTimeout(timer); }
    },
  };
  return { run, close, waitingForExit: waitingForExit.promise, releaseCleanup: release, push: (event: AgentEvent) => { queue.push(event); notify?.(); } };
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
  // Only in-process stream/stop progress uses this bounded drain. Filesystem,
  // transport, and queue handoff readiness use explicit checkpoints above.
  for (let n = 0; n < 10_000; n++) {
    if (predicate()) return;
    await yieldIO();
  }
  throw new Error('expected lifecycle transition was not observed');
}

// Checkpoints retain already-observed completions, so registering an observer
// after a fast run/unblock cannot lose its readiness signal.
function checkpoints() {
  let completed = 0;
  const pending = new Map<number, ReturnType<typeof deferred>>();
  return {
    complete() {
      completed++;
      pending.get(completed)?.resolve();
      pending.delete(completed);
    },
    waitFor(count: number) {
      if (completed >= count) return Promise.resolve();
      let next = pending.get(count);
      if (!next) { next = deferred(); pending.set(count, next); }
      return next.promise;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
