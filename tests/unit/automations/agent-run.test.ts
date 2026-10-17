import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_RESULT_FOOTER,
  automationScopeForReply,
  formatAgentFailureNotice,
  formatAgentResultPost,
  formatAutomationAgentPrompt,
  formatCatchUpPromptHint,
} from '../../../src/automations/agent-run';
import {
  automationFollowUpScope,
  automationRunScope,
  isAutomationRunScope,
  isAutomationScope,
} from '../../../src/bot/scope';
import { TurnJournal } from '../../../src/bot/turn-journal';

const fireAt = Date.UTC(2026, 0, 2, 12, 0, 0);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('agent-task result copy and follow-up mapping', () => {
  it('injects the bound group chat into the agent-task prompt', () => {
    const prompt = formatAutomationAgentPrompt({
      chatId: 'oc_group',
      createdBy: 'ou_alice',
      taskText: '每天总结本群',
      catchUp: false,
      timezone: 'UTC',
      fireAt,
    }, 'ou_bot');
    expect(prompt).toContain('<bridge_context>');
    expect(prompt).toContain('"chatId":"oc_group"');
    expect(prompt).toContain('"chatType":"group"');
    expect(prompt).toContain('每天总结本群');
  });

  it('formats on-time and catch-up result posts with the follow-up footer', () => {
    expect(formatAgentResultPost({
      body: '汇总完成',
      catchUp: false,
      timezone: 'UTC',
      fireAt,
    })).toBe(`汇总完成\n\n${AGENT_RESULT_FOOTER}`);
    expect(formatAgentResultPost({
      body: '汇总完成',
      catchUp: true,
      timezone: 'UTC',
      fireAt,
    })).toBe(`汇总完成\n\n（补跑，原定 12:00）\n\n${AGENT_RESULT_FOOTER}`);
    expect(formatCatchUpPromptHint('UTC', fireAt, fireAt)).toContain('补跑');
    expect(formatCatchUpPromptHint('UTC', fireAt, fireAt)).toContain('12:00');
    expect(formatCatchUpPromptHint('Asia/Shanghai', Date.UTC(2026, 9, 16, 19, 8), Date.UTC(2026, 9, 17, 20, 28)))
      .toContain('原定 10-17 03:08');
    expect(formatAgentResultPost({
      body: '汇总完成',
      catchUp: true,
      timezone: 'Asia/Shanghai',
      fireAt: Date.UTC(2026, 9, 16, 19, 8),
      now: Date.UTC(2026, 9, 17, 20, 28),
    })).toBe(`汇总完成\n\n（补跑，原定 10-17 03:08）\n\n${AGENT_RESULT_FOOTER}`);
    expect(formatAgentFailureNotice({
      kind: 'interrupted',
      reason: { type: 'shutdown-signal' },
      retriable: true,
      needsHuman: false,
    })).toBe('自动化任务中断：进程退出');
    expect(formatAgentFailureNotice({
      kind: 'interrupted',
      reason: { type: 'bridge-idle-watchdog' },
      retriable: true,
      needsHuman: false,
    })).toBe('自动化任务中断：空闲超时');
    expect(formatAgentFailureNotice({
      kind: 'failed',
      cause: 'unclassified',
      retriable: false,
      needsHuman: true,
    })).toBe('自动化任务中断：出错');
    expect(formatAgentFailureNotice({
      kind: 'interrupted',
      reason: { type: 'policy-guard' },
      retriable: false,
      needsHuman: false,
    }, { policyGuard: 'members' })).toBe(
      '自动化任务中断：策略拦截（成员增删）。任务已暂停，可在看板恢复或删除。',
    );
    expect(formatAgentResultPost({
      body: '自动化任务中断：缺少工作目录',
      catchUp: false,
      timezone: 'UTC',
      fireAt,
      followUp: false,
    })).toBe('自动化任务中断：缺少工作目录');
    for (const notice of [
      formatAgentFailureNotice({
        kind: 'interrupted',
        reason: { type: 'shutdown-signal' },
        retriable: true,
        needsHuman: false,
      }),
      formatAgentFailureNotice({
        kind: 'interrupted',
        reason: { type: 'policy-guard' },
        retriable: false,
        needsHuman: false,
      }, { policyGuard: 'members' }),
      formatAgentFailureNotice({
        kind: 'failed',
        cause: 'unclassified',
        retriable: false,
        needsHuman: true,
      }),
    ]) {
      expect(notice).not.toContain(AGENT_RESULT_FOOTER);
    }
    expect(formatAgentFailureNotice({
      kind: 'interrupted',
      reason: { type: 'shutdown-signal' },
      retriable: true,
      needsHuman: false,
    }, { catchUp: true, timezone: 'UTC', fireAt })).toBe(
      '自动化任务中断：进程退出\n\n（补跑，原定 12:00）',
    );
    expect(formatAgentResultPost({
      body: '  ',
      catchUp: false,
      timezone: 'UTC',
      fireAt,
    })).toBe(AGENT_RESULT_FOOTER);
  });

  it('maps a result post root to auto:<id>:<fireAt> and ignores reminder journal scopes', () => {
    const scope = automationRunScope(3, fireAt);
    expect(scope).toBe(`auto:3:${fireAt}`);
    expect(isAutomationRunScope(scope)).toBe(true);
    expect(isAutomationRunScope('auto:af:3@1000')).toBe(false);
    expect(isAutomationScope('auto:af:3@1000')).toBe(true);
    const posts = new Map([['om_result', scope]]);
    expect(automationFollowUpScope(['om_result'], posts)).toBe(scope);
    expect(automationFollowUpScope([undefined, 'om_other'], posts)).toBeUndefined();
  });

  it('does not anchor an interrupted or failed fire notice, and still anchors a completed result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-run-anchor-'));
    dirs.push(dir);
    const journal = new TurnJournal(join(dir, 'turn-journal.json'));
    const scope = automationRunScope(3, fireAt);
    const base = {
      chatId: 'oc_group',
      messageIds: [] as string[],
      senderId: 'ou_bot',
      initiatorId: 'ou_bot',
      initiatorType: 'bot' as const,
      status: 'settled' as const,
    };
    journal.enqueue({
      ...base,
      turnId: 'af:guard',
      scope,
      outcome: {
        kind: 'interrupted',
        reason: { type: 'policy-guard' },
        retriable: false,
        needsHuman: false,
      },
      reply: { markdown: 'guard', replyTo: '', replyMode: 'text', messageId: 'om_guard' },
    });
    journal.enqueue({
      ...base,
      turnId: 'af:fail',
      scope,
      outcome: { kind: 'failed', cause: 'unclassified', retriable: false, needsHuman: true },
      reply: { markdown: 'fail', replyTo: '', replyMode: 'text', messageId: 'om_fail' },
    });
    journal.enqueue({
      ...base,
      turnId: 'af:ok',
      scope,
      outcome: { kind: 'completed', retriable: false, needsHuman: false },
      reply: { markdown: 'ok', replyTo: '', replyMode: 'text', messageId: 'om_ok' },
    });
    journal.enqueue({
      ...base,
      turnId: 'af:partial',
      scope,
      outcome: { kind: 'partial', retriable: true, needsHuman: false },
      reply: { markdown: 'partial', replyTo: '', replyMode: 'text', messageId: 'om_partial' },
    });

    expect(automationScopeForReply(journal, {
      threadId: 'om_guard',
      rootId: 'om_guard',
      replyToMessageId: 'om_guard',
    })).toBeUndefined();
    expect(automationScopeForReply(journal, {
      threadId: 'om_fail',
      rootId: 'om_fail',
      replyToMessageId: 'om_fail',
    })).toBeUndefined();
    expect(automationScopeForReply(journal, {
      threadId: 'om_ok',
      rootId: 'om_ok',
      replyToMessageId: 'om_ok',
    })).toBe(scope);
    expect(automationScopeForReply(journal, {
      threadId: 'om_partial',
      rootId: 'om_partial',
      replyToMessageId: 'om_partial',
    })).toBe(scope);
    await journal.flush();
  });
});
