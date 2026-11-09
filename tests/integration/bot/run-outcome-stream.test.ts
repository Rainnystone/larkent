import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO, setTimeout as waitIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { CONTINUE_HINT } from '../../../src/bot/interruption-notice';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import * as logger from '../../../src/core/logger';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const PRINT_TIMEOUT_STDERR =
  '[agy] print timeout after 10m0s with turn in progress; returning partial output';
const PRINT_TIMEOUT_WARNING = '输出不完整（打印超时），可稍后继续';

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

  it('keeps the agy partial-outcome warning on the final reply', async () => {
    const h = await harness({ agentKind: 'antigravity' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.stderrSnapshot = '[agy] print timeout after 5m0s with turn in progress; returning partial output';
    run.push({ type: 'final_text', content: 'PARTIAL_ANSWER' });
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => rendered(h.channel).includes('PARTIAL_ANSWER'));
    expect(rendered(h.channel)).toContain('输出不完整（打印超时），可稍后继续');
  });

  it('does not repeat a partial warning already rendered on the progress stream', async () => {
    const h = await harness({ agentKind: 'antigravity' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'progress update' });
    await waitFor(() => rendered(h.channel).includes('progress update'));
    run.stderrSnapshot = '[agy] print timeout after 5m0s with turn in progress; returning partial output';
    run.push({ type: 'final_text', content: 'PARTIAL_ANSWER' });
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => rendered(h.channel).includes('PARTIAL_ANSWER'));
    const text = rendered(h.channel);
    expect(text).toContain('输出不完整（打印超时），可稍后继续');
    expect(text.split('输出不完整（打印超时），可稍后继续').length - 1).toBe(1);
  });

  it('keeps the agy partial warning when the progress stream finish is rejected', async () => {
    const warning = '输出不完整（打印超时），可稍后继续';
    const h = await harness({ agentKind: 'antigravity', journal: true });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'tool_use', id: 'tool-probe', name: 'probe_tool_xyz', input: {} });
    await waitFor(() => rendered(h.channel).includes('probe_tool_xyz'));
    h.channel.streamErrors.finish = new Error('stream finish rejected');
    run.stderrSnapshot = '[agy] print timeout after 5m0s with turn in progress; returning partial output';
    run.push({ type: 'final_text', content: 'PARTIAL_ANSWER' });
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    // stageReply lands before the fsync; the dedicated card is pushed after it.
    // Join that writer, then assert those two surfaces. The progress stream is
    // not in `sent`.
    await waitFor(() => stagedReply(h.journal) !== undefined);
    await h.journal?.flush();
    await waitFor(() => sentCard(h.channel.sent) !== undefined);
    const dedicated = sentCard(h.channel.sent) ?? '';
    expect(dedicated).toContain('PARTIAL_ANSWER');
    expect(dedicated).toContain(warning);
    expect(dedicated.split(warning).length - 1).toBe(1);
    expect(dedicated.split('PARTIAL_ANSWER').length - 1).toBe(1);
    expect(dedicated).not.toContain('probe_tool_xyz');
    const staged = stagedReply(h.journal) ?? '';
    expect(staged).toContain('PARTIAL_ANSWER');
    expect(staged).toContain(warning);
    expect(staged.split(warning).length - 1).toBe(1);
    expect(staged.split('PARTIAL_ANSWER').length - 1).toBe(1);
    expect(staged).not.toContain('probe_tool_xyz');
  });

  it('shows redacted signature copy on the card instead of raw stderr paths', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'cursor' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    const raw = [
      'failed to read /Users/someone/.cursor/projects/secret-repo/config.json',
      'RetriableError: Connection stalled repeatedly',
      'account: user@example.com',
    ].join('\n');
    run.stderrSnapshot = raw;
    run.push({ type: 'error', message: `cursor exited with code 1: ${raw}`, terminationReason: 'failed' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => String(entry.outcome).includes('transient-upstream')));
    const card = rendered(h.channel);
    expect(card).toContain('上游连接反复中断');
    expect(card).not.toContain('/Users/someone/.cursor');
    expect(card).not.toContain('user@example.com');
    expect(card).not.toContain('secret-repo');
  });

  it('hides unclassified stderr paths behind generic card copy', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'cursor' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    const raw = 'failed to read /Users/someone/.cursor/projects/secret-repo/config.json for user@example.com';
    run.stderrSnapshot = raw;
    run.push({ type: 'error', message: `cursor exited with code 1: ${raw}`, terminationReason: 'failed' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'failed:unclassified'));
    const card = rendered(h.channel);
    expect(card).toContain('agent 运行失败');
    expect(card).not.toContain('/Users/someone/.cursor');
    expect(card).not.toContain('user@example.com');
    expect(info.mock.calls.some((call) => call[0] === 'run' && call[1] === 'stderr-unclassified')).toBe(true);
  });

  it('does not append a failure notice when done matches a stale stderr signature', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'cursor' });
    await h.channel.handlers.message?.(message('first', 'please finish'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'final_text', content: 'FULL_REPLY' });
    run.stderrSnapshot = 'RetriableError: Connection stalled repeatedly';
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'completed'));
    const text = rendered(h.channel);
    expect(cardFinal(info).at(-1)).toMatchObject({ terminal: 'done', outcome: 'completed' });
    expect(text).toContain('FULL_REPLY');
    expect(text).not.toContain('继续');
    expect(text).not.toContain('agent 运行失败');
    expect(text).not.toContain('上游连接反复中断');
    expect(h.channel.sent.filter((item) => JSON.stringify(item.content).includes('FULL_REPLY'))).toHaveLength(1);
  });

  it.each([
    { name: 'card', messageReply: 'card' as const },
    { name: 'markdown', messageReply: 'markdown' as const },
    { name: 'text', messageReply: 'text' as const },
  ])('settles CLI error + exit 3 print-timeout as partial on $name without agent 失败', async ({
    messageReply,
  }) => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', messageReply });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'system', resumeHandle: 'sess-agy' });
    run.push({ type: 'final_text', content: 'PARTIAL_ANSWER' });
    run.stderrSnapshot = PRINT_TIMEOUT_STDERR;
    run.exit = 3;
    run.push({
      type: 'error',
      message: 'agy exited with code 3',
      terminationReason: 'failed',
    });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'partial'));
    expect(cardFinal(info).at(-1)).toMatchObject({ terminal: 'done', outcome: 'partial' });
    const text = rendered(h.channel);
    expect(text).toContain('PARTIAL_ANSWER');
    expect(countNeedle(text, PRINT_TIMEOUT_WARNING)).toBe(1);
    expect(text).not.toContain('agent 失败');
  });

  it('keeps useful partial text and does not resend an already-streamed print-timeout warning', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'progress update' });
    await waitFor(() => rendered(h.channel).includes('progress update'));
    run.push({ type: 'final_text', content: 'PARTIAL_ANSWER' });
    run.stderrSnapshot = PRINT_TIMEOUT_STDERR;
    run.exit = 3;
    run.push({
      type: 'error',
      message: 'agy exited with code 3',
      terminationReason: 'failed',
    });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'partial'));
    const text = rendered(h.channel);
    expect(text).toContain('PARTIAL_ANSWER');
    expect(text).toContain('progress update');
    expect(countNeedle(text, PRINT_TIMEOUT_WARNING)).toBe(1);
    expect(text).not.toContain('agent 失败');
  });

  it('explains an empty print-timeout error once when there is no partial answer', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.stderrSnapshot = PRINT_TIMEOUT_STDERR;
    run.exit = 3;
    run.push({
      type: 'error',
      message: 'agy exited with code 3',
      terminationReason: 'failed',
    });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'partial'));
    const text = rendered(h.channel);
    expect(countNeedle(text, PRINT_TIMEOUT_WARNING)).toBe(1);
    expect(text).not.toContain('agent 失败');
  });

  it('does not append a second print-timeout explanation when emptySuccessHint already supplied it', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'final_text', content: PRINT_TIMEOUT_WARNING });
    run.stderrSnapshot = PRINT_TIMEOUT_STDERR;
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'partial'));
    const text = rendered(h.channel);
    expect(countNeedle(text, PRINT_TIMEOUT_WARNING)).toBe(1);
    expect(text).not.toContain('Antigravity print-timeout');
    expect(text).not.toContain('agent 失败');
  });

  it('keeps a genuine current-turn error as failed with agent 失败', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.stderrSnapshot = 'agy exploded';
    run.exit = 1;
    run.push({
      type: 'error',
      message: 'agy exploded',
      terminationReason: 'failed',
    });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'failed:unclassified'));
    expect(cardFinal(info).at(-1)).toMatchObject({ terminal: 'error', outcome: 'failed:unclassified' });
    const text = rendered(h.channel);
    expect(text).toContain('agent 失败');
    expect(text).not.toContain(PRINT_TIMEOUT_WARNING);
  });

  it('offers continue for a retriable print-timeout partial and resumes the existing handle', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'system', resumeHandle: 'sess-agy' });
    run.push({ type: 'final_text', content: 'PARTIAL_ANSWER' });
    run.stderrSnapshot = PRINT_TIMEOUT_STDERR;
    run.exit = 3;
    run.push({
      type: 'error',
      message: 'agy exited with code 3',
      terminationReason: 'failed',
    });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'partial'));
    await waitFor(() => h.journal?.list().some((entry) => entry.continuation?.status === 'offered') === true);
    expect(h.journal?.list().some((entry) => entry.resumeHandle === 'sess-agy')).toBe(true);
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes(CONTINUE_HINT)));
    const noticeJson = JSON.stringify(
      h.channel.sent.find((item) => JSON.stringify(item.content).includes(CONTINUE_HINT))?.content,
    );
    expect(noticeJson).toContain('上一轮未完成（输出不完整）');
    expect(noticeJson).toContain(CONTINUE_HINT);
    expect(noticeJson).not.toContain('打印超时');
    expect(noticeJson).not.toContain('agent 失败');
    await h.channel.handlers.message?.(message('cont', '继续'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBe('sess-agy');
    expect(h.agent.runOptions[1]?.prompt).toContain(CONTINUE_HINT);
    expect(h.agent.runOptions[1]?.prompt).not.toContain('打印超时');
    const continued = h.agent.manual[1]!;
    continued.push({ type: 'final_text', content: 'CONTINUED' });
    continued.push({ type: 'done', terminationReason: 'normal' });
    continued.close();
    continued.releaseCleanup();
    await drainIO();
  }, 15_000);

  it('classifies agy print-timeout on exit 0 as partial', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity' });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.stderrSnapshot = '[agy] print timeout after 5m0s with turn in progress; returning partial output';
    run.push({ type: 'done', terminationReason: 'normal' });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'partial'));
    expect(cardFinal(info).at(-1)).toMatchObject({ terminal: 'done', outcome: 'partial' });
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
    expect(rendered(h.channel)).not.toContain('等待预算已用尽');
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

  it('does not pass the poisoned conversation id on 继续 after an antigravity error', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'system', resumeHandle: 'sess-agy-poisoned' });
    run.push({
      type: 'error',
      message: 'ECONNRESET: streamGenerateContent failed',
      terminationReason: 'failed',
    });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'failed:transient-upstream'));
    await waitFor(() => h.journal?.list().some((entry) => entry.continuation?.status === 'offered') === true);
    expect(h.journal?.list().every((entry) => entry.resumeHandle === undefined)).toBe(true);
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes(CONTINUE_HINT)));

    await h.channel.handlers.message?.(message('cont', '继续'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBeUndefined();
    const continued = h.agent.manual[1]!;
    continued.push({ type: 'final_text', content: 'FRESH_CONTINUED' });
    continued.push({ type: 'done', terminationReason: 'normal' });
    continued.close();
    continued.releaseCleanup();
    await drainIO();
  }, 15_000);

  it('keeps a current-turn antigravity ERROR as a failed outcome and notes that the next message starts a new session', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'system', resumeHandle: 'sess-agy-err' });
    run.push({
      type: 'error',
      message: 'FAILED_PRECONDITION (code 400): current turn failed',
      terminationReason: 'failed',
    });
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => entry.outcome === 'failed:unclassified'));
    expect(cardFinal(info).at(-1)).toMatchObject({ terminal: 'error', outcome: 'failed:unclassified' });
    await waitFor(() => rendered(h.channel).includes('agent 失败'));
    const text = rendered(h.channel);
    expect(text).toContain('agent 失败');
    expect(text).toContain('下一条消息将开启新会话');

    await h.channel.handlers.message?.(message('second', 'next message'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBeUndefined();
    const nextRun = h.agent.manual[1]!;
    nextRun.push({ type: 'final_text', content: 'FRESH_NEXT' });
    nextRun.push({ type: 'done', terminationReason: 'normal' });
    nextRun.close();
    nextRun.releaseCleanup();
    await drainIO();
  }, 15_000);

  it('keeps the antigravity session when the run fails without a CLI error result', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await harness({ agentKind: 'antigravity', journal: true });
    await h.channel.handlers.message?.(message('first', 'please run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'system', resumeHandle: 'sess-agy-keep' });
    // Process dies with stderr only: no translated `result` ERROR terminal.
    run.stderrSnapshot = 'agy exploded';
    run.exit = 1;
    run.close();
    run.releaseCleanup();
    await drainIO();
    await waitFor(() => cardFinal(info).some((entry) => String(entry.outcome).startsWith('failed')));
    expect(cardFinal(info).at(-1)).toMatchObject({ terminal: 'error' });
    await waitFor(() => rendered(h.channel).includes('agent 失败'));
    expect(rendered(h.channel)).not.toContain('下一条消息将开启新会话');
    expect(h.journal?.list().some((entry) => entry.resumeHandle === 'sess-agy-keep')).toBe(true);

    await h.channel.handlers.message?.(message('second', 'next message'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBe('sess-agy-keep');
    const nextRun = h.agent.manual[1]!;
    nextRun.push({ type: 'final_text', content: 'RESUMED_NEXT' });
    nextRun.push({ type: 'done', terminationReason: 'normal' });
    nextRun.close();
    nextRun.releaseCleanup();
    await drainIO();
  }, 15_000);
});

async function harness(options?: {
  agentKind?: 'claude' | 'cursor' | 'antigravity';
  journal?: boolean;
  messageReply?: 'card' | 'markdown' | 'text';
}) {
  const tmp = await createTmpProfile('run-outcome-stream-');
  const agentKind = options?.agentKind ?? 'claude';
  const journal = options?.journal
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
      messageReply: options?.messageReply ?? 'card',
      messageReplyMigrated: true,
      showToolCalls: true,
      runIdleTimeoutMinutes: 1,
      cotMessages: 'off',
    },
  });
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new StreamingFakeAgent(agentKind);
  const channel = createRecordingLarkChannel();
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg, agent, sessions, workspaces,
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
      configPath: join(tmp.root, 'config.json'), processId: 'test-outcome',
    },
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  cleanups.push(async () => {
    for (const run of agent.manual) run.releaseCleanup();
    await bridge.disconnect();
    await drainIO();
    await journal?.flush().catch(() => {});
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { channel, agent, journal };
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
  let exit: number | null | undefined;
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = () => { cleaned = true; resolve(); }; });
  const close = () => { closed = true; notify?.(); };
  const run: AgentRun & { stderrSnapshot?: string } = {
    runId: recorded.runId,
    get exit() { return exit; },
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
    set stderrSnapshot(value: string) { run.stderrSnapshot = value; },
    set exit(value: number | null) { exit = value; },
  };
}

function stagedReply(journal: TurnJournal | undefined): string | undefined {
  return journal?.list().find((entry) => entry.reply !== undefined)?.reply?.markdown;
}

function sentCard(sent: ReadonlyArray<{ content: unknown }>): string | undefined {
  const card = sent.find((item) => (
    typeof item.content === 'object' && item.content !== null && 'card' in item.content
  ));
  return card ? JSON.stringify(card.content) : undefined;
}

function rendered(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return JSON.stringify({ sent: channel.sent, streams: channel.streams });
}

function cardFinal(info: ReturnType<typeof vi.spyOn>) {
  return info.mock.calls
    .filter((call) => call[0] === 'card' && call[1] === 'final')
    .map((call) => call[2] as Record<string, unknown>);
}

function countNeedle(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function message(messageId: string, content: string): NormalizedMessage {
  return { messageId, content, chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_user',
    senderName: 'User', rawContentType: 'text', resources: [], mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

async function drainIO() { for (let n = 0; n < 50; n++) await yieldIO(); }
async function waitFor(predicate: () => boolean) {
  // Date and product timers are virtual here; asynchronous I/O still needs real time.
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await waitIO(5);
  }
  if (predicate()) return;
  throw new Error('timed out');
}
