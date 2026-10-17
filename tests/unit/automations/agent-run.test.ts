import { describe, expect, it } from 'vitest';
import {
  AGENT_RESULT_FOOTER,
  formatAgentFailureNotice,
  formatAgentResultPost,
  formatCatchUpPromptHint,
} from '../../../src/automations/agent-run';
import {
  automationFollowUpScope,
  automationRunScope,
  isAutomationRunScope,
  isAutomationScope,
} from '../../../src/bot/scope';

const fireAt = Date.UTC(2026, 0, 2, 12, 0, 0);

describe('agent-task result copy and follow-up mapping', () => {
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
    expect(formatCatchUpPromptHint('UTC', fireAt)).toContain('补跑');
    expect(formatCatchUpPromptHint('UTC', fireAt)).toContain('12:00');
    expect(formatAgentFailureNotice({
      kind: 'interrupted',
      reason: { type: 'shutdown-signal' },
      retriable: true,
      needsHuman: false,
    })).toBe(`自动化任务中断：进程退出\n\n${AGENT_RESULT_FOOTER}`);
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
});
