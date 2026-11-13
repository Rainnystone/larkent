import { mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO, setTimeout as waitIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityJsonlTranslator } from '../../../src/agent/antigravity/jsonl';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import { CotClient } from '../../../src/bot/cot';
import { ABANDON_HINT, CONTINUE_HINT } from '../../../src/bot/interruption-notice';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import * as logger from '../../../src/core/logger';
import { SpawnFailed } from '../../../src/runtime/errors';
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

  it('delivers one clear error card instead of silence when the automatic rerun fails to start (TurnStartFailed)', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const fail = vi.spyOn(logger.log, 'fail').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true, messageReply: 'card' });
    await h.channel.handlers.message?.(message('first', 'summarise the diff'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();

    h.agent.prepareRun = async () => {
      throw new SpawnFailed('agy binary check failed', new Error('ENOENT'), 'agent-prepare-failed');
    };
    firstAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    expect(fail.mock.calls.some((call) => String(call[1]).includes('agy binary check failed'))).toBe(true);
    expect(h.channel.sent).toHaveLength(1);
    const text = rendered(h.channel);
    expect(text).toContain('agent 失败');
    expect(text).toContain(FRESH_SESSION_NOTICE);
    expect(text).not.toContain(CONTINUE_HINT);
    expect(text).not.toContain('notice.continue');
    const entries = h.journal!.list();
    expect(entries.some((entry) => entry.status === 'reply-delivered')).toBe(true);
    expect(entries.some((entry) => entry.status === 'queued' || entry.status === 'running')).toBe(false);
  });

  it('delivers the first failure card when the automatic rerun is skipped after topic-context fetch because session writer was superseded', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    let listCalled = false;
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    cleanups.push(async () => { releaseList(); });
    const h = await harness({
      agentKind: 'antigravity',
      journal: true,
      messageReply: 'card',
      chatMode: 'topic',
      onMessageList: async () => {
        listCalled = true;
        await listGate;
      },
    });
    const otherDir = join(h.tmpRoot, 'other-cwd');
    await mkdir(otherDir, { recursive: true });

    const scope = 'oc_topic:omt_t1';
    h.sessions.set(scope, 'sess-topic', h.cwd, 'antigravity');
    h.catalog.upsertActive({
      scopeId: scope,
      agentId: 'antigravity',
      cwdRealpath: h.cwd,
      policyFingerprint: 'fp-seed',
      resumeHandle: 'sess-topic',
    });

    await h.channel.handlers.message?.(topicMessage('topic-1', 'check topic'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-topic' });
    firstAttempt.push({
      type: 'error',
      message: 'upstream failed',
      terminationReason: 'failed',
      invalidateResume: 'sess-topic',
    });
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await waitFor(() => listCalled);

    // Supersede session writer during fetchTopicContext before Attempt 2 starts.
    await h.channel.handlers.message?.(topicMessage('cd-cmd', `/cd ${otherDir}`));
    await drainIO();
    releaseList();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    expect(h.agent.runOptions).toHaveLength(1);
    const firstReplyTexts = h.channel.sent
      .filter((row) => (row.options as { replyTo?: string } | undefined)?.replyTo === 'topic-1')
      .map((row) => JSON.stringify(row.content))
      .join('\n');
    expect(firstReplyTexts).toContain('agent 失败');
    expect(firstReplyTexts).toContain(FRESH_SESSION_NOTICE);
    expect(firstReplyTexts).not.toContain(CONTINUE_HINT);
  });

  it('unrecords the accepted batch for backfill instead of swallowing it when shutdown aborts the automatic rerun handoff', async () => {
    let listCalled = false;
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    cleanups.push(async () => { releaseList(); });
    const h = await harness({
      agentKind: 'antigravity',
      journal: true,
      ledger: true,
      messageReply: 'card',
      chatMode: 'topic',
      onMessageList: async () => {
        listCalled = true;
        await listGate;
      },
    });
    const scope = 'oc_topic:omt_t1';
    h.sessions.set(scope, 'sess-topic', h.cwd, 'antigravity');

    const inbound = topicMessage('topic-shutdown', 'recover me after restart');
    await h.channel.handlers.message?.(inbound);
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    expect(h.ledger?.has('topic-shutdown')).toBe(true);

    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-topic' });
    firstAttempt.push({
      type: 'error',
      message: 'upstream failed',
      terminationReason: 'failed',
      invalidateResume: 'sess-topic',
    });
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await waitFor(() => listCalled);

    const disconnecting = h.bridge.disconnect();
    await drainIO();
    releaseList();
    await disconnecting;

    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.ledger?.has('topic-shutdown')).toBe(false);
    expect(h.ledger?.getIncompleteFrom()).toBeDefined();
    expect(h.ledger!.getIncompleteFrom()!).toBeLessThanOrEqual(inbound.createTime);
  });

  it('preserves the original task instead of bare 继续 when a keep-session continuation hits no-answer ERROR and auto-reruns fresh', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true, messageReply: 'card' });
    const originalTask = 'refactor the parser and run unit tests';

    // Turn 0: interrupted after attaching to sess-keep -> offers keep-session 继续.
    await h.channel.handlers.message?.(message('turn-0', originalTask));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run0 = h.agent.manual[0]!;
    run0.push({ type: 'system', resumeHandle: 'sess-keep' });
    run0.push({ type: 'done', terminationReason: 'interrupted' });
    run0.close();
    run0.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBe('sess-keep');

    // Turn 1: user sends 继续 -> Attempt 1 resumes sess-keep, then hits no-answer ERROR with invalidateResume.
    await h.channel.handlers.message?.(message('turn-1-cont', '继续'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBe('sess-keep');
    expect(h.agent.runOptions[1]?.prompt).toContain(CONTINUE_HINT);
    expect(h.agent.runOptions[1]?.prompt).toContain(originalTask);

    const attempt1 = h.agent.manual[1]!;
    attempt1.push({ type: 'system', resumeHandle: 'sess-keep' });
    attempt1.push({
      type: 'error',
      message: 'upstream failed',
      terminationReason: 'failed',
      invalidateResume: 'sess-keep',
    });
    attempt1.close();
    attempt1.releaseCleanup();
    await drainIO();

    // Attempt 2: fresh auto-rerun must carry originalTask instead of bare "继续".
    await waitFor(() => h.agent.manual.length === 3);
    expect(h.agent.runOptions[2]?.resumeHandle).toBeUndefined();
    const rerunPrompt = h.agent.runOptions[2]!.prompt;
    expect(rerunPrompt).toContain(originalTask);
    expect(rerunPrompt).toContain(JSON.stringify({ text: originalTask }));
    expect(rerunPrompt).toContain(`原始输入：\\n${originalTask}`);
    expect(rerunPrompt).not.toContain('原始输入：\\n继续');
    expect(rerunPrompt).not.toContain('原始输入：\n继续');
    expect(rerunPrompt).not.toContain(JSON.stringify({ text: '继续' }));

    const attempt2 = h.agent.manual[2]!;
    attempt2.push({ type: 'system', resumeHandle: 'sess-fresh' });
    attempt2.push({ type: 'final_text', content: 'RECOVERED-CONTINUE' });
    attempt2.push({ type: 'done', terminationReason: 'normal', resumeHandle: 'sess-fresh' });
    attempt2.close();
    attempt2.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 2);
    await drainIO();

    expect(rendered(h.channel)).toContain('RECOVERED-CONTINUE');
  });

  it('preserves the abandoned-turn hint across fresh auto-rerun after fetching topic history', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const abandonedTask = 'ABANDONED_OLD_TASK: drop legacy table';
    const newTask = 'NEW_TASK: only update README';
    const h = await harness({
      agentKind: 'antigravity',
      journal: true,
      messageReply: 'card',
      chatMode: 'topic',
      messagesByChat: {
        omt_t1: [
          {
            message_id: 'topic-0',
            chat_id: 'oc_topic',
            msg_type: 'text',
            create_time: String(Date.now() - 5_000),
            sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user' },
            body: { content: JSON.stringify({ text: abandonedTask }) },
          },
        ],
      },
    });

    // Turn 0 in topic: interrupted after attaching to sess-topic -> offers 继续.
    await h.channel.handlers.message?.(topicMessage('topic-0', abandonedTask));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run0 = h.agent.manual[0]!;
    run0.push({ type: 'system', resumeHandle: 'sess-topic' });
    run0.push({ type: 'done', terminationReason: 'interrupted' });
    run0.close();
    run0.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    // Turn 1 in topic: user sends a new message (abandoning Turn 0). Attempt 1 hits no-answer ERROR.
    await h.channel.handlers.message?.(topicMessage('topic-1', newTask));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBe('sess-topic');
    expect(h.agent.runOptions[1]?.prompt).toContain(ABANDON_HINT);

    const attempt1 = h.agent.manual[1]!;
    attempt1.push({ type: 'system', resumeHandle: 'sess-topic' });
    attempt1.push({
      type: 'error',
      message: 'upstream failed',
      terminationReason: 'failed',
      invalidateResume: 'sess-topic',
    });
    attempt1.close();
    attempt1.releaseCleanup();
    await drainIO();

    // Attempt 2 fetches topic history (containing abandonedTask) AND must still carry ABANDON_HINT.
    await waitFor(() => h.agent.manual.length === 3);
    expect(h.agent.runOptions[2]?.resumeHandle).toBeUndefined();
    const rerunPrompt = h.agent.runOptions[2]!.prompt;
    expect(rerunPrompt).toContain(abandonedTask);
    expect(rerunPrompt).toContain(newTask);
    expect(rerunPrompt).toContain(ABANDON_HINT);

    const attempt2 = h.agent.manual[2]!;
    attempt2.push({ type: 'system', resumeHandle: 'sess-topic-fresh' });
    attempt2.push({ type: 'final_text', content: 'README-UPDATED' });
    attempt2.push({ type: 'done', terminationReason: 'normal', resumeHandle: 'sess-topic-fresh' });
    attempt2.close();
    attempt2.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 2);
    await drainIO();

    expect(rendered(h.channel)).toContain('README-UPDATED');
  });

  it('does not auto-rerun when an inbound CLI self-sent message already arrived for this chat before no-answer ERROR', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true, messageReply: 'card' });
    await h.channel.handlers.message?.(message('first', 'post update via cli'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);

    await h.channel.handlers.message?.({
      messageId: 'om_cli_echo',
      content: 'already posted by cli',
      chatId: 'oc_dm',
      chatType: 'p2p',
      senderId: h.channel.botIdentity.openId,
      senderName: h.channel.botIdentity.name,
      rawContentType: 'text',
      resources: [],
      mentionedBot: false,
      createTime: Date.now(),
    } as unknown as NormalizedMessage);

    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBeUndefined();
    const text = rendered(h.channel);
    expect(text).toContain('agent 失败');
    expect(text).toContain(FRESH_SESSION_NOTICE);
  });

  it('does not auto-rerun when agy already IM-sent to this chat via lark-cli tool call before no-answer ERROR', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true, messageReply: 'card' });
    await h.channel.handlers.message?.(message('first', 'post update via cli tool'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);

    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push({
      type: 'tool_use',
      id: 'tool-1',
      name: 'run_command',
      input: { command: 'lark-cli im +messages-send --chat-id oc_dm --text already_delivered' },
    });
    firstAttempt.push({
      type: 'tool_result',
      id: 'tool-1',
      output: '{"code":0,"data":{"message_id":"om_sent_1"}}',
      isError: false,
    });
    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBeUndefined();
    const text = rendered(h.channel);
    expect(text).toContain('agent 失败');
    expect(text).toContain(FRESH_SESSION_NOTICE);
  });

  it('bounds a stalled suppressed progress-stream finalization with outboundTimeoutMs and still recalls and auto-reruns', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    let releaseStalledStream!: () => void;
    const stalledStreamGate = new Promise<void>((resolve) => { releaseStalledStream = resolve; });
    cleanups.push(async () => { releaseStalledStream(); });
    let streamCount = 0;

    const h = await harness({
      agentKind: 'antigravity',
      journal: true,
      messageReply: 'card',
      outboundTimeoutMs: 250,
    });
    const origStream = h.channel.stream.bind(h.channel);
    h.channel.stream = async (chatId, input, opts) => {
      streamCount += 1;
      const cardInput = (input as {
        card?: { producer: (ctrl: { messageId: string; update(card: unknown): Promise<void> }) => Promise<void> };
      } | undefined)?.card;
      if (streamCount === 1 && cardInput) {
        await cardInput.producer({
          messageId: 'om_stalled_stream_1',
          async update() {},
        });
        await stalledStreamGate;
        return { messageId: 'om_stalled_stream_1' };
      }
      return origStream(chatId, input, opts);
    };

    await h.channel.handlers.message?.(message('first', 'check stalled stream'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);

    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push({
      type: 'tool_use',
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'src/index.ts' },
    });
    await drainIO();
    expect(streamCount).toBe(1);

    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await waitFor(() =>
      info.mock.calls.some((call) => call[0] === 'turn' && call[1] === 'auto-rerun-scheduled'),
    );
    await drainIO();

    // Advance past outboundTimeoutMs (250ms); stalled finalization must not block rerun or recall.
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => h.agent.manual.length === 2);

    const recalled = h.channel.callLog
      .filter((call): call is Extract<typeof call, { op: 'recall' }> => call.op === 'recall')
      .map((call) => call.messageId);
    expect(recalled).toContain('om_stalled_stream_1');

    const secondAttempt = h.agent.manual[1]!;
    secondAttempt.push({ type: 'system', resumeHandle: 'sess-fresh' });
    secondAttempt.push({ type: 'final_text', content: 'RECOVERED-AFTER-STALLED-STREAM' });
    secondAttempt.push({ type: 'done', terminationReason: 'normal', resumeHandle: 'sess-fresh' });
    secondAttempt.close();
    secondAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    const text = rendered(h.channel);
    expect(text).toContain('RECOVERED-AFTER-STALLED-STREAM');
    expect(text).not.toContain('agent 失败');
  });

  it('honors /stop during the topic-context fetch gap between Attempt 1 and the automatic rerun without starting Attempt 2 or leaving silence', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    let listCalled = false;
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    cleanups.push(async () => { releaseList(); });
    const h = await harness({
      agentKind: 'antigravity',
      journal: true,
      messageReply: 'card',
      chatMode: 'topic',
      onMessageList: async () => {
        listCalled = true;
        await listGate;
      },
    });
    const scope = 'oc_topic:omt_t1';
    h.sessions.set(scope, 'sess-topic', h.cwd, 'antigravity');

    await h.channel.handlers.message?.(topicMessage('topic-stop-gap', 'check topic'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-topic' });
    firstAttempt.push({
      type: 'error',
      message: 'upstream failed',
      terminationReason: 'failed',
      invalidateResume: 'sess-topic',
    });
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await waitFor(() => listCalled);

    await h.channel.handlers.message?.(topicMessage('stop-cmd', '/stop'));
    await drainIO();
    releaseList();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    expect(
      info.mock.calls.some(
        (call) =>
          call[0] === 'command'
          && call[1] === 'stop'
          && (call[2] as { interrupted?: boolean } | undefined)?.interrupted === true,
      ),
    ).toBe(true);
    expect(h.agent.runOptions).toHaveLength(1);
    const firstReplyTexts = h.channel.sent
      .filter((row) => (row.options as { replyTo?: string } | undefined)?.replyTo === 'topic-stop-gap')
      .map((row) => JSON.stringify(row.content))
      .join('\n');
    expect(firstReplyTexts).toContain('agent 失败');
    expect(firstReplyTexts).toContain(FRESH_SESSION_NOTICE);
    expect(firstReplyTexts).not.toContain(CONTINUE_HINT);
    expect(h.journal!.list().some((entry) => entry.status === 'reply-delivered')).toBe(true);
  });

  it('honors /stop during Attempt 1 recall cleanup before runAgentBatch resumes without starting Attempt 2 or leaving silence', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    let recallCalled = false;
    let releaseRecall!: () => void;
    const recallGate = new Promise<void>((resolve) => { releaseRecall = resolve; });
    cleanups.push(async () => { releaseRecall(); });

    const h = await harness({
      agentKind: 'antigravity',
      journal: true,
      messageReply: 'card',
    });
    const origRecall = h.channel.recallMessage.bind(h.channel);
    h.channel.recallMessage = async (messageId: string) => {
      recallCalled = true;
      await recallGate;
      return origRecall(messageId);
    };

    await h.channel.handlers.message?.(message('first', 'check recall stop gap'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push({
      type: 'tool_use',
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'src/index.ts' },
    });
    await drainIO();

    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();
    firstAttempt.releaseCleanup();
    await waitFor(() => recallCalled);

    await h.channel.handlers.message?.(message('stop-during-recall', '/stop'));
    await drainIO();
    releaseRecall();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    expect(
      info.mock.calls.some(
        (call) =>
          call[0] === 'command'
          && call[1] === 'stop'
          && (call[2] as { interrupted?: boolean } | undefined)?.interrupted === true,
      ),
    ).toBe(true);
    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(1);
    const text = rendered(h.channel);
    expect(text).toContain('agent 失败');
    expect(text).toContain(FRESH_SESSION_NOTICE);
    expect(text).not.toContain(CONTINUE_HINT);
  });

  it('suppresses and recalls Attempt 1 CoT bubble on auto-rerun so a successful rerun leaves no failed CoT bubble', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    let cotCreateCount = 0;
    const cotEventsById = new Map<string, Array<{ event_type: string; content: string }>>();
    const cotCompletions: Array<{ cotId: string; messageId: string; reason: string }> = [];

    vi.spyOn(CotClient.prototype, 'create').mockImplementation(async () => {
      cotCreateCount += 1;
      return {
        cot_id: `cot_attempt_${cotCreateCount}`,
        message_id: `om_cot_attempt_${cotCreateCount}`,
      };
    });
    vi.spyOn(CotClient.prototype, 'update').mockImplementation(async (ref, events) => {
      const list = cotEventsById.get(ref.cotId) ?? [];
      list.push(...events.map((evt) => ({ event_type: evt.event_type, content: evt.content })));
      cotEventsById.set(ref.cotId, list);
    });
    vi.spyOn(CotClient.prototype, 'complete').mockImplementation(async (ref, reason) => {
      cotCompletions.push({ cotId: ref.cotId, messageId: ref.messageId, reason });
    });

    const h = await harness({
      agentKind: 'antigravity',
      journal: true,
      messageReply: 'card',
      cotMessages: 'brief',
    });

    await h.channel.handlers.message?.(message('first', 'explain architecture'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push({ type: 'thinking', delta: 'inspecting modules' });
    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();
    firstAttempt.releaseCleanup();

    await waitFor(() => h.agent.manual.length === 2);
    const secondAttempt = h.agent.manual[1]!;
    secondAttempt.push({ type: 'system', resumeHandle: 'sess-fresh' });
    secondAttempt.push({ type: 'thinking', delta: 'drafting clean answer' });
    secondAttempt.push({ type: 'final_text', content: 'COT-RECOVERED-OK' });
    secondAttempt.push({ type: 'done', terminationReason: 'normal', resumeHandle: 'sess-fresh' });
    secondAttempt.close();
    secondAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    expect(cotCreateCount).toBe(2);
    const firstCotEventTypes = (cotEventsById.get('cot_attempt_1') ?? []).map((evt) => evt.event_type);
    expect(firstCotEventTypes).not.toContain('RUN_ERROR');
    expect(cotCompletions).toEqual([
      { cotId: 'cot_attempt_2', messageId: 'om_cot_attempt_2', reason: 'done' },
    ]);
    const recalled = h.channel.callLog
      .filter((call): call is Extract<typeof call, { op: 'recall' }> => call.op === 'recall')
      .map((call) => call.messageId);
    expect(recalled).toContain('om_cot_attempt_1');
    expect(recalled).not.toContain('om_cot_attempt_2');

    const text = rendered(h.channel);
    expect(text).toContain('COT-RECOVERED-OK');
    expect(text).not.toContain('agent 失败');
    expect(text).not.toContain(FRESH_SESSION_NOTICE);
  });

  it('still completes Attempt 2 CoT bubble with RUN_ERROR when the automatic rerun itself fails', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    let cotCreateCount = 0;
    const cotEventsById = new Map<string, Array<{ event_type: string; content: string }>>();
    const cotCompletions: Array<{ cotId: string; messageId: string; reason: string }> = [];

    vi.spyOn(CotClient.prototype, 'create').mockImplementation(async () => {
      cotCreateCount += 1;
      return {
        cot_id: `cot_fail_${cotCreateCount}`,
        message_id: `om_cot_fail_${cotCreateCount}`,
      };
    });
    vi.spyOn(CotClient.prototype, 'update').mockImplementation(async (ref, events) => {
      const list = cotEventsById.get(ref.cotId) ?? [];
      list.push(...events.map((evt) => ({ event_type: evt.event_type, content: evt.content })));
      cotEventsById.set(ref.cotId, list);
    });
    vi.spyOn(CotClient.prototype, 'complete').mockImplementation(async (ref, reason) => {
      cotCompletions.push({ cotId: ref.cotId, messageId: ref.messageId, reason });
    });

    const h = await harness({
      agentKind: 'antigravity',
      journal: true,
      messageReply: 'card',
      cotMessages: 'brief',
    });

    await h.channel.handlers.message?.(message('first', 'explain architecture'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const firstAttempt = h.agent.manual[0]!;
    firstAttempt.push({ type: 'system', resumeHandle: 'sess-agy' });
    firstAttempt.push(AGY_ERROR);
    firstAttempt.close();
    firstAttempt.releaseCleanup();

    await waitFor(() => h.agent.manual.length === 2);
    const secondAttempt = h.agent.manual[1]!;
    secondAttempt.push({ type: 'system', resumeHandle: 'sess-agy-rerun' });
    secondAttempt.push(AGY_ERROR_RERUN);
    secondAttempt.close();
    secondAttempt.releaseCleanup();
    await waitFor(() => flushEndCount(info) === 1);
    await drainIO();

    expect(cotCreateCount).toBe(2);
    expect((cotEventsById.get('cot_fail_1') ?? []).map((evt) => evt.event_type)).not.toContain('RUN_ERROR');
    expect((cotEventsById.get('cot_fail_2') ?? []).map((evt) => evt.event_type)).toContain('RUN_ERROR');
    expect(cotCompletions).toEqual([
      { cotId: 'cot_fail_2', messageId: 'om_cot_fail_2', reason: 'error' },
    ]);
    const recalled = h.channel.callLog
      .filter((call): call is Extract<typeof call, { op: 'recall' }> => call.op === 'recall')
      .map((call) => call.messageId);
    expect(recalled).toContain('om_cot_fail_1');
    expect(recalled).not.toContain('om_cot_fail_2');
    expect(rendered(h.channel)).toContain('agent 失败');
  });
});

async function harness(options: {
  agentKind: 'antigravity' | 'claude';
  journal?: boolean;
  ledger?: boolean;
  messageReply?: 'text' | 'card';
  cotMessages?: 'off' | 'brief' | 'detailed';
  chatMode?: 'group' | 'topic';
  outboundTimeoutMs?: number;
  messagesByChat?: Record<string, unknown[]>;
  onMessageList?: () => Promise<void>;
}) {
  const tmp = await createTmpProfile('agy-error-discards-resume-');
  const agentKind = options.agentKind;
  const journal = options.journal
    ? new TurnJournal(join(tmp.profile, 'turn-journal.json'))
    : undefined;
  if (journal) await journal.load();
  const ledger = options.ledger
    ? new BackfillLedger(join(tmp.profile, 'backfill-state.json'))
    : undefined;
  if (ledger) await ledger.load();
  const mediaDir = join(tmp.profile, 'media');
  if (journal) await mkdir(mediaDir, { recursive: true });
  const cfg = createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'], admins: ['ou_user'], allowedChats: ['oc_topic'] },
    preferences: {
      messageReply: options.messageReply ?? 'text',
      messageReplyMigrated: true,
      showToolCalls: true,
      runIdleTimeoutMinutes: 1,
      cotMessages: options.cotMessages ?? 'off',
      requireMentionInGroup: false,
    },
  });
  const requestedCwd = join(tmp.root, 'requested-cwd');
  await symlink(tmp.workspace, requestedCwd, process.platform === 'win32' ? 'junction' : 'dir');
  cfg.workspaces.default = requestedCwd;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new StreamingFakeAgent(agentKind);
  const channel = createRecordingLarkChannel({
    chatMode: options.chatMode,
    ...(options.messagesByChat ? { messagesByChat: options.messagesByChat } : {}),
  });
  if (options.onMessageList) {
    const origList = channel.rawClient.im.v1.message.list.bind(channel.rawClient.im.v1.message);
    channel.rawClient.im.v1.message.list = async (params: unknown) => {
      await options.onMessageList!();
      return origList(params);
    };
  }
  sdk.channel = channel;
  const cwd = await realpath(requestedCwd);
  const bridge = await startChannel({
    cfg, agent, sessions, sessionCatalog: catalog, workspaces,
    probe: async () => true,
    ...(options.outboundTimeoutMs !== undefined ? { outboundTimeoutMs: options.outboundTimeoutMs } : {}),
    ...(ledger ? { ledger } : {}),
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
    for (const run of agent.manual) {
      run.close();
      run.releaseCleanup();
    }
    await bridge.disconnect().catch(() => {});
    await drainIO();
    await journal?.flush().catch(() => {});
    await ledger?.flush().catch(() => {});
    await Promise.all([sessions.flush(), catalog.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { channel, agent, journal, ledger, sessions, catalog, cwd, bridge, tmpRoot: tmp.root };
}

class StreamingFakeAgent extends FakeAgentAdapter {
  readonly manual: ReturnType<typeof manualRun>[] = [];
  prepareRun?: AgentAdapter['prepareRun'];
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

function topicMessage(messageId: string, content: string): NormalizedMessage {
  return { messageId, content, chatId: 'oc_topic', threadId: 'omt_t1', chatType: 'group',
    senderId: 'ou_user', senderName: 'User', rawContentType: 'text', resources: [],
    mentionedBot: true, createTime: Date.now(),
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
