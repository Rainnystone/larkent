import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { TurnJournal } from '../../../src/bot/turn-journal';
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

const NOW = 1_760_000_000_000;
const STALL_AFTER_RECOVERY_MS = 2 * 60_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('stall check after recovery', () => {
  it('stops a run silent since before the outage within 2 min with a retriable notice', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(message('first', 'first request'));
    await vi.advanceTimersByTimeAsync(600);
    await h.agent.started;
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'WORKING' });
    await waitFor(() => rendered(h.channel).includes('WORKING'));

    await vi.advanceTimersByTimeAsync(5_000);
    const since = Date.now();
    await vi.advanceTimersByTimeAsync(1_000);
    await h.bridge.recover({ since, until: Date.now(), hostSuspended: false });

    await vi.advanceTimersByTimeAsync(STALL_AFTER_RECOVERY_MS - 1);
    expect(h.agent.runs[0]!.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => rendered(h.channel).includes('2 分钟无响应'));
    expect(h.agent.runs[0]!.stopped).toBe(true);
    await drainIO();
    await waitFor(() => rendered(h.channel).includes('空闲超时'));
    expect(rendered(h.channel)).toContain('notice.continue');
  });

  it('reviews a tool-call run that started after last Feishu evidence when the host slept', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(message('first', 'please run the tool'));
    await vi.advanceTimersByTimeAsync(600);
    await h.agent.started;
    const run = h.agent.manual[0]!;
    run.push({ type: 'tool_use', id: 'tool-1', name: 'long_tool', input: {} });
    await waitFor(() => rendered(h.channel).includes('long_tool'));

    const toolAt = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);
    const suspendStartedAt = Date.now();
    await vi.advanceTimersByTimeAsync(1_000);
    await h.bridge.recover({
      since: toolAt - 15_000,
      until: Date.now(),
      hostSuspended: true,
      suspendStartedAt,
    });

    await vi.advanceTimersByTimeAsync(STALL_AFTER_RECOVERY_MS - 1);
    expect(h.agent.runs[0]!.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => rendered(h.channel).includes('2 分钟无响应'));
    expect(h.agent.runs[0]!.stopped).toBe(true);
  });

  it('after a host suspend, a silent open-tool run is stopped and posts one retriable notice within 2 min', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(message('first', 'please run the tool'));
    await vi.advanceTimersByTimeAsync(600);
    await h.agent.started;
    const run = h.agent.manual[0]!;
    run.push({ type: 'tool_use', id: 'tool-1', name: 'long_tool', input: {} });
    await waitFor(() => rendered(h.channel).includes('long_tool'));

    await vi.advanceTimersByTimeAsync(5_000);
    const since = Date.now();
    await vi.advanceTimersByTimeAsync(1_000);
    await h.bridge.recover({ since, until: Date.now(), hostSuspended: true });

    await vi.advanceTimersByTimeAsync(STALL_AFTER_RECOVERY_MS - 1);
    expect(h.agent.runs[0]!.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => rendered(h.channel).includes('2 分钟无响应'));
    expect(h.agent.runs[0]!.stopped).toBe(true);
    await drainIO();
    await waitFor(() => rendered(h.channel).includes('空闲超时'));
    expect(rendered(h.channel)).toContain('notice.continue');
    expect((rendered(h.channel).match(/notice\.continue/g) ?? []).length).toBe(1);
  });

  it('does not stop a 10-minute open tool call after a network-only outage', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(message('first', 'please run the tool'));
    await vi.advanceTimersByTimeAsync(600);
    await h.agent.started;
    const run = h.agent.manual[0]!;
    run.push({ type: 'tool_use', id: 'tool-1', name: 'long_tool', input: {} });
    await waitFor(() => rendered(h.channel).includes('long_tool'));

    await vi.advanceTimersByTimeAsync(5_000);
    const since = Date.now();
    await vi.advanceTimersByTimeAsync(1_000);
    await h.bridge.recover({ since, until: Date.now(), hostSuspended: false });

    await vi.advanceTimersByTimeAsync(STALL_AFTER_RECOVERY_MS);
    expect(h.agent.runs[0]!.stopped).toBe(false);
    expect(rendered(h.channel)).not.toContain('2 分钟无响应');

    run.push({ type: 'tool_result', id: 'tool-1', output: 'TOOL_OK', isError: false });
    run.push({ type: 'text', delta: 'DONE_AFTER_TOOL' });
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => rendered(h.channel).includes('DONE_AFTER_TOOL'));
    expect(rendered(h.channel)).not.toContain('2 分钟无响应');
    expect(rendered(h.channel)).not.toContain('空闲超时');
    const deliveries = h.channel.snapshotCalls().filter((call) => call.op === 'send' || call.op === 'stream');
    expect(deliveries).toHaveLength(1);
    expect(JSON.stringify(deliveries[0])).toContain('DONE_AFTER_TOOL');
  });

  it('leaves a run that keeps producing output alone', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(message('first', 'first request'));
    await vi.advanceTimersByTimeAsync(600);
    await h.agent.started;
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'WORKING' });
    await waitFor(() => rendered(h.channel).includes('WORKING'));

    await vi.advanceTimersByTimeAsync(5_000);
    const since = Date.now();
    await vi.advanceTimersByTimeAsync(1_000);
    await h.bridge.recover({ since, until: Date.now(), hostSuspended: false });

    run.push({ type: 'text', delta: ' STILL_GOING' });
    await waitFor(() => rendered(h.channel).includes('STILL_GOING'));

    await vi.advanceTimersByTimeAsync(STALL_AFTER_RECOVERY_MS);
    expect(h.agent.runs[0]!.stopped).toBe(false);
    expect(rendered(h.channel)).not.toContain('2 分钟无响应');
    expect(rendered(h.channel)).not.toContain('空闲超时');
  });
});

async function harness() {
  const tmp = await createTmpProfile('stall-after-recovery-');
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'));
  await journal.load();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: {
      messageReply: 'card',
      showToolCalls: true,
      cotMessages: 'off',
    },
    reliability: { notice: true },
  });
  cfg.workspaces.default = tmp.workspace;
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
    appPaths: {
      mediaDir,
      secretsFile: join(tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(tmp.profile, '.keystore.salt'),
    },
    controls: {
      profile: 'claude',
      profileConfig: cfg,
      cfg,
      ownerRefreshState: 'unknown',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-stall-recovery',
    },
  });
  cleanups.push(async () => {
    for (const run of agent.manual) run.releaseCleanup();
    await bridge.disconnect();
    await drainIO();
    await Promise.all([sessions.flush(), workspaces.flush(), journal.flush()]);
    await tmp.cleanup();
  });
  return { channel, agent, bridge };
}

class StreamingFakeAgent extends FakeAgentAdapter {
  readonly manual: ReturnType<typeof manualRun>[] = [];
  private markStarted!: () => void;
  readonly started = new Promise<void>(resolve => { this.markStarted = resolve; });
  constructor() { super({ id: 'claude' }); }
  override run(opts: AgentRunOptions): AgentRun {
    const recorded = super.run(opts);
    const manual = manualRun(recorded);
    this.manual.push(manual);
    this.markStarted();
    return manual.run;
  }
}

function manualRun(recorded: AgentRun) {
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
      release();
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
  for (let n = 0; n < 10_000; n++) {
    if (predicate()) return;
    await yieldIO();
  }
  throw new Error('expected stall-after-recovery transition was not observed');
}
