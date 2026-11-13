import { mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO, setTimeout as waitIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityJsonlTranslator } from '../../../src/agent/antigravity/jsonl';
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
const AGY_ERROR_RERUN: AgentEvent = {
  type: 'error',
  message: 'agent executor error: Bad Gateway',
  terminationReason: 'failed',
  invalidateResume: 'sess-agy-rerun',
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('agy error discards resume', { timeout: 20_000 }, () => {
  it('automatically reruns once in a fresh session on no-answer agy ERROR and delivers one normal reply with no failure or 继续 card', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true, messageReply: 'card' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await drainIO();

    // User sends nothing; bridge automatically starts Attempt 2 in a fresh session.
    await waitFor(() => h.agent.manual.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBeUndefined();
    expect(h.agent.runOptions[1]?.prompt).toContain(CONTINUE_HINT);
    expect(h.agent.runOptions[1]?.prompt).toContain('please run');
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBeUndefined();
    expect(h.catalog.entries().some((entry) => entry.status === 'active' && entry.resumeHandle === 'sess-agy')).toBe(false);

    const secondAttempt = h.agent.manual[1]!;
    secondAttempt.push({ type: 'system', resumeHandle: 'sess-fresh' });
    secondAttempt.push({ type: 'final_text', content: 'RECOVERED-OK' });
    secondAttempt.push({ type: 'done', terminationReason: 'normal' });
    secondAttempt.close();
    secondAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    expect(cardFinal(info)).toEqual([expect.objectContaining({ terminal: 'done', outcome: 'completed' })]);
    const text = rendered(h.channel);
    expect(text).toContain('RECOVERED-OK');
    expect(text).not.toContain('agent 失败');
    expect(text).not.toContain(FRESH_SESSION_NOTICE);
    expect(text).not.toContain(CONTINUE_HINT);
    expect(text).not.toContain('notice.continue');
    expect(h.journal?.list().some((entry) => entry.continuation?.status === 'offered')).toBe(false);
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBe('sess-fresh');

    await h.channel.handlers.message?.(message('second', 'follow up'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 3);
    expect(h.agent.runOptions[2]?.resumeHandle).toBe('sess-fresh');
    const next = h.agent.manual[2]!;
    next.push({ type: 'final_text', content: 'NEXT' });
    next.push({ type: 'done', terminationReason: 'normal' });
    next.close();
    next.releaseCleanup();
    await drainIO();
  });

  it('recalls an opened progress card from Attempt 1 on mid-turn no-answer ERROR so a successful rerun leaves no failure card', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const rawFixture = await readFile(
      join(process.cwd(), 'tests/fixtures/antigravity/error-interim-narration.jsonl'),
      'utf8',
    );
    const translator = new AntigravityJsonlTranslator();
    const translated = rawFixture
      .trim()
      .split('\n')
      .flatMap((line) => translator.translate(JSON.parse(line) as unknown));

    const h = await harness({ agentKind: 'antigravity', journal: true, messageReply: 'card' });
    await h.channel.handlers.message?.(message('first', 'check logs'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    for (const evt of translated) firstAttempt.push(evt);
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await drainIO();

    await waitFor(() => h.agent.manual.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBeUndefined();
    expect(h.agent.runOptions[1]?.prompt).toContain(CONTINUE_HINT);

    const secondAttempt = h.agent.manual[1]!;
    secondAttempt.push({ type: 'system', resumeHandle: 'sess-clean' });
    secondAttempt.push({ type: 'final_text', content: 'CLEAN-RECOVERY' });
    secondAttempt.push({ type: 'done', terminationReason: 'normal' });
    secondAttempt.close();
    secondAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    const text = rendered(h.channel);
    expect(text).toContain('CLEAN-RECOVERY');
    expect(text).not.toContain('agent 失败');
    expect(text).not.toContain(FRESH_SESSION_NOTICE);
    expect(text).not.toContain(CONTINUE_HINT);
    if (h.channel.streams.length > 0) {
      const recalled = h.channel.callLog
        .filter((call): call is Extract<typeof call, { op: 'recall' }> => call.op === 'recall')
        .map((call) => call.messageId);
      expect(recalled).toContain(h.channel.streams[0]?.messageId);
    }
  });

  it('shows one clear error, no 继续 card, and no third run when the automatic rerun also fails', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true, messageReply: 'card' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await drainIO();

    await waitFor(() => h.agent.manual.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBeUndefined();
    const secondAttempt = h.agent.manual[1]!;
    secondAttempt.push({ type: 'system', resumeHandle: 'sess-agy-rerun' });
    secondAttempt.push(AGY_ERROR_RERUN);
    secondAttempt.close();
    secondAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await vi.advanceTimersByTimeAsync(1_000);
    await drainIO();

    expect(h.agent.runOptions).toHaveLength(2);
    expect(cardFinal(info)).toEqual([expect.objectContaining({ terminal: 'error', outcome: 'failed:unclassified' })]);
    expect(h.channel.sent).toHaveLength(1);
    const text = rendered(h.channel);
    expect(text).toContain('agent 失败');
    expect(text).toContain(FRESH_SESSION_NOTICE);
    expect(text).not.toContain(CONTINUE_HINT);
    expect(text).not.toContain('notice.continue');
    expect(h.journal?.list().some((entry) => entry.continuation?.status === 'offered')).toBe(false);
    expect(h.journal?.list().some((entry) => Boolean(entry.resumeHandle))).toBe(false);
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBeUndefined();

    await h.channel.handlers.message?.(message('second', 'try again'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 3);
    expect(h.agent.runOptions[2]?.resumeHandle).toBeUndefined();
    const third = h.agent.manual[2]!;
    third.push({ type: 'final_text', content: 'FRESH' });
    third.push({ type: 'done', terminationReason: 'normal' });
    third.close();
    third.releaseCleanup();
    await drainIO();
  });

  it('suppresses 继续 card even when the automatic rerun fails before attaching to a conversation', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await drainIO();

    await waitFor(() => h.agent.manual.length === 2);
    const secondAttempt = h.agent.manual[1]!;
    secondAttempt.push({ type: 'error', message: 'agy exited with code 1', terminationReason: 'failed' });
    secondAttempt.close();
    secondAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    expect(h.agent.runOptions).toHaveLength(2);
    expect(h.channel.sent).toHaveLength(1);
    const text = rendered(h.channel);
    expect(text).toContain('agent 失败');
    expect(text).not.toContain(CONTINUE_HINT);
    expect(text).not.toContain('notice.continue');
    expect(h.journal?.list().some((entry) => entry.continuation?.status === 'offered')).toBe(false);
  });

  it('does not auto-rerun a pre-attachment CLI error without invalidateResume', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'error', message: 'invalid --model foo', terminationReason: 'failed' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'failed:unclassified'));
    await vi.advanceTimersByTimeAsync(1_000);
    await drainIO();

    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('handles /stop during the automatic rerun like a normal run', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true, messageReply: 'card' });
    await h.channel.handlers.message?.(message('first', 'long work'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await drainIO();

    await waitFor(() => h.agent.manual.length === 2);
    const secondAttempt = h.agent.manual[1]!;
    secondAttempt.push({ type: 'system', resumeHandle: 'sess-rerun' });
    await drainIO();

    await h.channel.handlers.message?.(message('stop-msg', '/stop'));
    secondAttempt.close();
    secondAttempt.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'interrupted:user-stop'));
    await drainIO();

    expect(h.agent.runOptions).toHaveLength(2);
    const text = rendered(h.channel);
    expect(text).not.toContain(CONTINUE_HINT);
    expect(text).not.toContain('notice.continue');
    expect(h.journal?.list().some((entry) => entry.continuation?.status === 'offered')).toBe(false);
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBe('sess-rerun');
  });

  it('handles a superseding /new and a queued follow-up message during the automatic rerun like a normal run', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true });
    await h.channel.handlers.message?.(message('first', 'step one'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await drainIO();

    await waitFor(() => h.agent.manual.length === 2);
    const secondAttempt = h.agent.manual[1]!;
    secondAttempt.push({ type: 'system', resumeHandle: 'sess-rerun' });
    await drainIO();

    // Queue an ordinary follow-up while the rerun is active; it waits until the rerun settles.
    await h.channel.handlers.message?.(message('followup', 'step two'));
    await vi.advanceTimersByTimeAsync(600);
    expect(h.agent.runOptions).toHaveLength(2);

    secondAttempt.push({ type: 'final_text', content: 'STEP-ONE-DONE' });
    secondAttempt.push({ type: 'done', terminationReason: 'normal' });
    secondAttempt.close();
    secondAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 3);
    expect(h.agent.runOptions[2]?.resumeHandle).toBe('sess-rerun');
    expect(h.agent.runOptions[2]?.prompt).toContain('step two');

    // Now test superseding /new during an active rerun on the next turn.
    const thirdRun = h.agent.manual[2]!;
    thirdRun.push({ type: 'error', message: 'boom', terminationReason: 'failed', invalidateResume: 'sess-rerun' });
    thirdRun.close();
    thirdRun.releaseCleanup();
    await drainIO();

    await waitFor(() => h.agent.manual.length === 4);
    const fourthAttempt = h.agent.manual[3]!;
    fourthAttempt.push({ type: 'system', resumeHandle: 'sess-rerun-2' });
    await drainIO();

    await h.channel.handlers.message?.(message('new-cmd', '/new'));
    fourthAttempt.close();
    fourthAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 2);
    expect(cardFinal(info).some((entry) => entry.outcome === 'interrupted:superseded:new')).toBe(true);
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBeUndefined();
    expect(h.agent.runOptions).toHaveLength(4);
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

  it('delivers a normal card reply without failure tail or 继续 card on agy ERROR-with-answer, yet discards the poisoned session so the next turn logs session fresh', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(logger.log, 'warn').mockImplementation(() => {});
    const poisoned = '6b9dd5db-bd08-4f29-adb6-a0380b7f563f';
    const rawFixture = await readFile(
      join(process.cwd(), 'tests/fixtures/antigravity/error-with-response.jsonl'),
      'utf8',
    );
    const translator = new AntigravityJsonlTranslator();
    const translated = rawFixture
      .trim()
      .split('\n')
      .flatMap((line) => translator.translate(JSON.parse(line) as unknown));

    const h = await harness({ agentKind: 'antigravity', journal: true, messageReply: 'card' });
    await h.channel.handlers.message?.(message('first', 'ping'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    for (const evt of translated) run.push(evt);
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(
      () =>
        cardFinal(info).some((entry) => entry.outcome === 'completed') &&
        h.channel.callLog.some((call) => call.op === 'send' || call.op === 'stream'),
    );
    await drainIO();

    expect(cardFinal(info).at(-1)).toMatchObject({ terminal: 'done', outcome: 'completed' });
    const text = rendered(h.channel);
    expect(text).toContain('PONG-01');
    expect(text).not.toContain('agent 失败');
    expect(text).not.toContain(FRESH_SESSION_NOTICE);
    expect(text).not.toContain(CONTINUE_HINT);
    expect(h.journal?.list().some((entry) => entry.continuation?.status === 'offered')).toBe(false);
    expect(h.journal?.list().some((entry) => entry.resumeHandle === poisoned)).toBe(false);
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBeUndefined();
    expect(
      h.catalog
        .entries()
        .some((entry) => entry.status === 'active' && entry.resumeHandle === poisoned),
    ).toBe(false);
    expect(
      warn.mock.calls.some(
        (call) => call[0] === 'agent' && call[1] === 'error-with-answer-recovered',
      ),
    ).toBe(true);

    const sessionLogsBeforeSecond = info.mock.calls.filter((call) => call[0] === 'session').length;
    await h.channel.handlers.message?.(message('second', 'next question'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBeUndefined();
    const secondSessionLogs = info.mock.calls
      .filter((call) => call[0] === 'session')
      .slice(sessionLogsBeforeSecond);
    expect(secondSessionLogs).toContainEqual(['session', 'fresh', { cwd: h.cwd }]);

    const next = h.agent.manual[1]!;
    next.push({ type: 'final_text', content: 'FRESH-REPLY' });
    next.push({ type: 'done', terminationReason: 'normal' });
    next.close();
    next.releaseCleanup();
    await drainIO();
  });
});

async function harness(options: {
  agentKind: 'antigravity' | 'claude';
  journal?: boolean;
  messageReply?: 'text' | 'card';
}) {
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
      messageReply: options.messageReply ?? 'text',
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
  return JSON.stringify({
    sent: channel.sent,
    streams: channel.streams,
    calls: channel.snapshotCalls(),
  });
}

function cardFinal(info: ReturnType<typeof vi.spyOn>) {
  return info.mock.calls
    .filter((call) => call[0] === 'card' && call[1] === 'final')
    .map((call) => call[2] as Record<string, unknown>);
}

function flushEndCount(info: ReturnType<typeof vi.spyOn>) {
  return info.mock.calls.filter((call) => call[0] === 'flush' && call[1] === 'end').length;
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
