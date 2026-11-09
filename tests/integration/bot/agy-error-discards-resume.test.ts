import { mkdir, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO, setTimeout as waitIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { CONTINUE_HINT } from '../../../src/bot/interruption-notice';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import * as logger from '../../../src/core/logger';
import { SessionCatalog } from '../../../src/session/catalog';
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

const FRESH_SESSION_NOTICE = '下一条消息将开始新会话';
const AGY_ERROR: AgentEvent = {
  type: 'error',
  message: 'FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
  terminationReason: 'failed',
  invalidateResume: 'sess-agy',
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('agy error discards resume', { timeout: 20_000 }, () => {
  it('clears the resume handle after an agy ERROR so the next run has no conversation id', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'system', resumeHandle: 'sess-agy' });
    run.push(AGY_ERROR);
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'failed:unclassified'));
    expect(cardFinal(info).at(-1)).toMatchObject({ terminal: 'error', outcome: 'failed:unclassified' });
    const text = rendered(h.channel);
    expect(text).toContain('agent 失败');
    expect(text).toContain(FRESH_SESSION_NOTICE);
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBeUndefined();
    expect(h.catalog.entries().some((entry) => entry.status === 'active' && entry.resumeHandle === 'sess-agy')).toBe(false);

    await h.channel.handlers.message?.(message('second', 'try again'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBeUndefined();
    const next = h.agent.manual[1]!;
    next.push({ type: 'final_text', content: 'FRESH' });
    next.push({ type: 'done', terminationReason: 'normal' });
    next.close();
    next.releaseCleanup();
    await drainIO();
  });

  it('keeps resuming the same conversation after an agy SUCCESS', async () => {
    const h = await harness({ agentKind: 'antigravity' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'system', resumeHandle: 'sess-agy' });
    run.push({ type: 'final_text', content: 'OK' });
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity') === 'sess-agy');

    await h.channel.handlers.message?.(message('second', 'follow up'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBe('sess-agy');
    const next = h.agent.manual[1]!;
    next.push({ type: 'final_text', content: 'RESUMED' });
    next.push({ type: 'done', terminationReason: 'normal' });
    next.close();
    next.releaseCleanup();
    await drainIO();
  });

  it('does not pass the old conversation id when 继续 follows an agy error', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'system', resumeHandle: 'sess-agy' });
    run.push(AGY_ERROR);
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'failed:unclassified'));
    await waitFor(() => h.journal?.list().some((entry) => entry.continuation?.status === 'offered') === true);
    expect(h.journal?.list().some((entry) => entry.resumeHandle === 'sess-agy')).toBe(false);
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes(CONTINUE_HINT)));
    await h.channel.handlers.message?.(message('cont', '继续'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBeUndefined();
    const continued = h.agent.manual[1]!;
    continued.push({ type: 'final_text', content: 'FRESH' });
    continued.push({ type: 'done', terminationReason: 'normal' });
    continued.close();
    continued.releaseCleanup();
    await drainIO();
  });

  it('keeps a non-agy adapter error session', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'claude' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'system', resumeHandle: 'sess-claude' });
    run.push({ type: 'error', message: 'boom', terminationReason: 'failed' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'failed:unclassified'));
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'claude')).toBe('sess-claude');
    const text = rendered(h.channel);
    expect(text).toContain('agent 失败');
    expect(text).not.toContain(FRESH_SESSION_NOTICE);

    await h.channel.handlers.message?.(message('second', 'try again'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBe('sess-claude');
    const next = h.agent.manual[1]!;
    next.push({ type: 'final_text', content: 'RESUMED' });
    next.push({ type: 'done', terminationReason: 'normal' });
    next.close();
    next.releaseCleanup();
    await drainIO();
  });
});

async function harness(options: { agentKind: 'antigravity' | 'claude'; journal?: boolean }) {
  const tmp = await createTmpProfile('agy-error-discards-resume-');
  const agentKind = options.agentKind;
  const journal = options.journal
    ? new TurnJournal(join(tmp.profile, 'turn-journal.json'))
    : undefined;
  if (journal) await journal.load();
  const mediaDir = join(tmp.profile, 'media');
  if (journal) await mkdir(mediaDir, { recursive: true });
  const cfg = createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: {
      messageReply: 'text',
      messageReplyMigrated: true,
      showToolCalls: true,
      runIdleTimeoutMinutes: 1,
      cotMessages: 'off',
    },
  });
  const requestedCwd = join(tmp.root, 'requested-cwd');
  await symlink(tmp.workspace, requestedCwd, process.platform === 'win32' ? 'junction' : 'dir');
  cfg.workspaces.default = requestedCwd;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new StreamingFakeAgent(agentKind);
  const channel = createRecordingLarkChannel();
  sdk.channel = channel;
  const cwd = await realpath(requestedCwd);
  const bridge = await startChannel({
    cfg, agent, sessions, sessionCatalog: catalog, workspaces,
    probe: async () => true,
    ...(journal ? {
      journal,
      appPaths: {
        mediaDir,
        secretsFile: join(tmp.profile, 'secrets.enc'),
        keystoreSaltFile: join(tmp.profile, '.keystore.salt'),
      },
    } : {}),
    controls: { profile: agentKind, profileConfig: cfg, cfg, botOwnerId: 'ou_user',
      ownerRefreshState: 'ok',
      async refreshOwner() {}, async restart() {}, async exit() {},
      configPath: join(tmp.root, 'config.json'), processId: 'test-agy-error-resume',
    },
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  cleanups.push(async () => {
    for (const run of agent.manual) run.releaseCleanup();
    await bridge.disconnect();
    await drainIO();
    await journal?.flush().catch(() => {});
    await Promise.all([sessions.flush(), catalog.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { channel, agent, journal, sessions, catalog, cwd };
}

class StreamingFakeAgent extends FakeAgentAdapter {
  readonly manual: ReturnType<typeof manualRun>[] = [];
  constructor(id: string) { super({ id }); }
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
  return {
    run,
    close,
    releaseCleanup: release,
    push: (event: AgentEvent) => { queue.push(event); notify?.(); },
  };
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
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await waitIO(5);
  }
  if (predicate()) return;
  throw new Error('timed out');
}
