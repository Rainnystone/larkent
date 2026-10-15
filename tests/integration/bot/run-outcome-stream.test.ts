import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import * as logger from '../../../src/core/logger';
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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('run outcome stream', () => {
  it('lets a real terminal beat a concurrent stop request', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness();
    await h.channel.handlers.message?.(message('first', 'please finish'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'ALMOST' });
    await waitFor(() => rendered(h.channel).includes('ALMOST'));
    await h.channel.handlers.message?.(message('stop', '/stop'));
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'completed'));
    const final = cardFinal(info).at(-1)!;
    expect(final).toMatchObject({ terminal: 'done', outcome: 'completed' });
    expect(rendered(h.channel)).toContain('ALMOST');
    expect(rendered(h.channel)).not.toContain('已被中断');
  });

  it('drops the terminal and shows interrupted when runOutcome is off', async () => {
    const h = await harness({ runOutcome: false });
    await h.channel.handlers.message?.(message('first', 'please finish'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'ALMOST' });
    await waitFor(() => rendered(h.channel).includes('ALMOST'));
    await h.channel.handlers.message?.(message('stop', '/stop'));
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    run.releaseCleanup();
    await waitFor(() => rendered(h.channel).includes('已被中断'));
  });

  it('renders runner timeout copy distinct from the idle watchdog', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(logger.log, 'warn').mockImplementation(() => {});
    const h = await harness();
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'error', message: 'cursor timeout', terminationReason: 'timeout' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => rendered(h.channel).includes('运行超时'));
    expect(rendered(h.channel)).not.toContain('分钟无响应');
    const final = cardFinal(info).at(-1)!;
    expect(final).toMatchObject({
      terminal: 'runner_timeout',
      stopReason: 'runner-timeout',
      outcome: 'interrupted:runner-timeout',
    });
    const failed = warn.mock.calls
      .filter((call) => call[0] === 'run' && call[1] === 'failed')
      .map((call) => call[2] as Record<string, unknown>);
    expect(failed.at(-1)).toMatchObject({
      stopReason: 'runner-timeout',
      outcome: 'interrupted:runner-timeout',
    });
  });
});

async function harness(reliability?: { runOutcome?: boolean }) {
  const tmp = await createTmpProfile('run-outcome-stream-');
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: 'card', showToolCalls: true, runIdleTimeoutMinutes: 1, cotMessages: 'off' },
    ...(reliability ? { reliability } : {}),
  });
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new StreamingFakeAgent();
  const channel = createRecordingLarkChannel();
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg, agent, sessions, workspaces,
    controls: { profile: 'claude', profileConfig: cfg, cfg, ownerRefreshState: 'unknown',
      async refreshOwner() {}, async restart() {}, async exit() {},
      configPath: join(tmp.root, 'config.json'), processId: 'test-outcome',
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

function cardFinal(info: ReturnType<typeof vi.spyOn>) {
  return info.mock.calls
    .filter((call) => call[0] === 'card' && call[1] === 'final')
    .map((call) => call[2] as Record<string, unknown>);
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
  throw new Error('timed out');
}
