import { describe, expect, it } from 'vitest';
import {
  AUTO_AGENT_DISABLED,
  AUTO_NEW_USAGE,
  AUTO_P2P_HINT,
  AUTOMATION_CONFIRM_PENDING_LINE,
  assessAutomationProposal,
  automationProposalSuffix,
  automationRejectReplyLine,
  planAutomationProposalReply,
} from '../../../src/automations/command';

/** 2026-10-17 11:00 Asia/Shanghai. */
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);

describe('automation proposal reply suffix', () => {
  it('quotes the original schedule and a usable example on one line', () => {
    expect(automationRejectReplyLine('无法解析时间表。', '今天 15:50', '没有创建任务', {
      now: NOW,
      timezone: 'Asia/Shanghai',
    })).toBe(
      '⚠️ 没有创建任务：无法解析时间表「今天 15:50」。可写成「明天 09:00」「2026-10-18 15:50」「10 分钟后」。',
    );
  });

  it('shares schedule acceptance with submit and does not treat a missing end as a rejection', () => {
    expect(assessAutomationProposal({
      taskType: 'reminder',
      scheduleText: '今天 15:50 运行一次',
      now: NOW,
      timezone: 'Asia/Shanghai',
      hasCwd: true,
    })).toMatchObject({ outcome: 'reject', reason: 'invalid-schedule' });

    const ok = assessAutomationProposal({
      taskType: 'reminder',
      scheduleText: '10 分钟后',
      now: NOW,
      timezone: 'Asia/Shanghai',
      hasCwd: true,
    });
    expect(ok.outcome).toBe('confirm');
    expect(automationProposalSuffix(ok, '10 分钟后')).toBe(AUTOMATION_CONFIRM_PENDING_LINE);

    const pending = assessAutomationProposal({
      taskType: 'reminder',
      scheduleText: '每个工作日 09:00',
      now: NOW,
      timezone: 'Asia/Shanghai',
      hasCwd: true,
    });
    expect(pending.outcome).toBe('needs-end');
    expect(automationProposalSuffix(pending, '每个工作日 09:00')).toBeUndefined();
  });

  it('refuses a private chat, a disabled agent task, and a missing store before claiming a card', () => {
    const base = {
      taskType: 'reminder' as const,
      scheduleText: '10 分钟后',
      now: NOW,
      timezone: 'Asia/Shanghai',
      hasCwd: true,
      group: true,
      agentTasks: false,
      canSave: true,
    };
    expect(planAutomationProposalReply({ ...base, group: false })).toEqual({
      outcome: 'refuse',
      message: AUTO_P2P_HINT,
    });
    expect(planAutomationProposalReply({ ...base, taskType: 'agent' })).toEqual({
      outcome: 'refuse',
      message: AUTO_AGENT_DISABLED,
    });
    expect(planAutomationProposalReply({ ...base, canSave: false }).outcome).toBe('refuse');
    expect(planAutomationProposalReply({ ...base, canSave: false })).toMatchObject({
      message: AUTO_NEW_USAGE,
    });
    expect(automationProposalSuffix(
      planAutomationProposalReply(base),
      '10 分钟后',
    )).toBe(AUTOMATION_CONFIRM_PENDING_LINE);
  });
});
