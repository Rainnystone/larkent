import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { CodexJsonlTranslator } from '../../../src/agent/codex/jsonl';
import { DevinTranscriptTranslator } from '../../../src/agent/devin/transcript';
import { ActiveRuns, type RunHandle } from '../../../src/bot/active-runs';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async importOriginal => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const ANSWER = 'PARTIAL_ANSWER_PART_TWO';
const LONG_ANSWER = 'SLOW_ANSWER_STILL_STREAMING';
const CHAT = 'test-chat';
const USER = 'test-user';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

type Cli = 'codex' | 'devin';

const chunk = (text: string, messageId: string) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
  _meta: { 'cognition.ai/messageId': messageId },
});

const seedUpdates: Record<Cli, unknown[]> = {
  codex: [
    { type: 'thread.started', thread_id: 'test-thread' },
    { type: 'item.completed', item: { type: 'agent_message', text: ANSWER } },
  ],
  devin: [chunk('PARTIAL_ANSWER_', 'msg-1'), chunk('PART_TWO', 'msg-1')],
};

describe.each(['codex', 'devin'] as const)('%s held-back answer by stop reason', cli => {
  it('/stop posts the buffered answer in exactly one visible message', async () => {
    const h = await harness(cli);
    await h.channel.handlers.message?.(message('msg-ask', 'please answer'));
    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(1);

    await h.channel.handlers.message?.(message('msg-stop', '/stop'));
    await waitFor(() => visible(h.channel).some(body => body.includes(ANSWER)));
    await drainIO();
    expect(visible(h.channel).filter(body => body.includes(ANSWER))).toHaveLength(1);
  });

  it('/new supersedes the run and withholds the buffered answer', async () => {
    const h = await harness(cli);
    await h.channel.handlers.message?.(message('msg-ask', 'please answer'));
    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(1);

    await h.channel.handlers.message?.(message('msg-new', '/new'));
    await waitFor(() => h.channel.sent.some(row => JSON.stringify(row.content).includes('新会话')));
    await drainIO();
    expect(h.channel.sent.map(row => JSON.stringify(row.content)).join('\n')).not.toContain(ANSWER);
  });

  it('an idle timeout stops the run as bridge-idle-watchdog and withholds the answer', async () => {
    const h = await harness(cli);
    await h.channel.handlers.message?.(message('msg-ask', 'please answer'));
    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await drainIO();
    expect(h.handles[0]!.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    expect(h.channel.sent.map(row => JSON.stringify(row.content)).join('\n')).not.toContain(ANSWER);
  });

  it('bridge shutdown withholds the buffered answer', async () => {
    const h = await harness(cli);
    await h.channel.handlers.message?.(message('msg-ask', 'please answer'));
    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(1);

    await h.bridge.disconnect();
    await drainIO();
    expect(h.channel.sent.map(row => JSON.stringify(row.content)).join('\n')).not.toContain(ANSWER);
  });
});

describe('devin buffered chunks and the idle watchdog', () => {
  it('keeps a long quietly streamed answer alive past the idle bound', async () => {
    const h = await harness('devin');
    await h.channel.handlers.message?.(message('msg-ask', 'please answer'));
    await vi.advanceTimersByTimeAsync(600);
    await h.waitForRun(1);
    const run = h.agent.manual[0]!;

    for (const piece of ['SLOW_', 'ANSWER_', 'STILL_', 'STREAMING']) {
      await vi.advanceTimersByTimeAsync(40_000);
      run.update(chunk(piece, 'msg-1'));
      await drainIO();
    }
    await vi.advanceTimersByTimeAsync(20_000);
    run.finish('end_turn');
    run.close();
    await waitFor(() => visible(h.channel).some(body => body.includes(LONG_ANSWER)));
    await drainIO();

    expect(run.stopped).toBe(false);
    expect(h.handles[0]!.stopRequest).toBeUndefined();
    expect(visible(h.channel).filter(body => body.includes(LONG_ANSWER))).toHaveLength(1);
  });
});

async function harness(cli: Cli) {
  const tmp = await createTmpProfile(`devin-stop-reasons-${cli}-`);
  const cfg = createDefaultProfileConfig({
    agentKind: cli,
    ...(cli === 'codex' ? { codex: { binaryPath: join(tmp.root, 'test-codex-bin') } } : {}),
    accounts: { app: { id: 'test-app', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER] },
    preferences: {
      messageReply: 'markdown',
      messageReplyMigrated: true,
      cotMessages: 'off',
      showToolCalls: false,
      runIdleTimeoutMinutes: 1,
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
  const agent = new TranslatingFakeAgent(cli);
  const channel = createRecordingLarkChannel();
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg, agent, sessions, workspaces,
    controls: { profile: `test-${cli}`, profileConfig: cfg, cfg, ownerRefreshState: 'unknown',
      async refreshOwner() {}, async restart() {}, async exit() {},
      configPath: join(tmp.root, 'config.json'), processId: `test-${cli}` },
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  cleanups.push(async () => {
    await bridge.disconnect();
    await drainIO();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    channel, agent, bridge, handles,
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

// The run feeds the real translator for the agent kind, so a bridge stop sees
// exactly the terminal events the ACP/JSONL runners emit on teardown.
class TranslatingFakeAgent extends FakeAgentAdapter {
  readonly manual: ReturnType<typeof translatingRun>[] = [];
  readonly started = checkpoints();
  async prepareRun(): Promise<void> {}
  constructor(private readonly cli: Cli) { super({ id: cli }); }
  override run(opts: AgentRunOptions): AgentRun {
    const recorded = super.run(opts);
    const manual = translatingRun(recorded, this.cli);
    for (const update of seedUpdates[this.cli]) manual.update(update);
    this.manual.push(manual);
    this.started.complete();
    return manual.run;
  }
}

function translatingRun(recorded: AgentRun, cli: Cli) {
  const translator = cli === 'devin' ? new DevinTranscriptTranslator() : new CodexJsonlTranslator();
  const queue: AgentEvent[] = [];
  let notify: (() => void) | undefined;
  let closed = false;
  let stopped = false;
  const push = (events: Iterable<AgentEvent>) => { queue.push(...events); notify?.(); };
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
      stopped = true;
      await recorded.stop();
      push(translator instanceof DevinTranscriptTranslator
        ? translator.finish('cancelled')
        : translator.finish('interrupted'));
      close();
    },
    waitForExit: async () => true,
  };
  return {
    run, close, push,
    update: (update: unknown) => push(translator.translate(update)),
    finish: (reason: 'end_turn') => {
      if (translator instanceof DevinTranscriptTranslator) push(translator.finish(reason));
    },
    get stopped() { return stopped; },
  };
}

function visible(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return [
    ...channel.sent.map(row => JSON.stringify(row.content)),
    ...channel.streams.map(s => JSON.stringify([s.cardUpdates, s.markdownContents])),
  ];
}

function message(messageId: string, content: string): NormalizedMessage {
  return { messageId, content, chatId: CHAT, chatType: 'p2p', senderId: USER,
    senderName: 'User', rawContentType: 'text', resources: [], mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

async function drainIO() { for (let n = 0; n < 50; n++) await yieldIO(); }
async function waitFor(predicate: () => boolean) {
  for (let n = 0; n < 10_000; n++) {
    if (predicate()) return;
    await yieldIO();
  }
  throw new Error('expected lifecycle transition was not observed');
}

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
