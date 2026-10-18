import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_PROPOSAL_INSTRUCTION,
  extractAutomationProposal,
  parseAutomationProposalJson,
  proposalTextFromState,
  shouldHonorAutomationProposal,
  stripProposalFromState,
} from '../../../src/automations/proposal';
import { initialState } from '../../../src/card/run-state';

describe('automation proposal extract', () => {
  it('strips the tag, keeps visible prose, and ignores chat/scope/creator', () => {
    const visible = '好的，10 分钟后提醒你交周报。';
    const text = `${visible}\n<automation_proposal>\n${JSON.stringify({
      taskType: 'reminder',
      schedule: '10 分钟后',
      name: '交周报',
      taskText: '提醒我交周报',
      chatId: 'oc_spoof',
      createdBy: 'ou_spoof',
      scope: 'auto:9:1',
    })}\n</automation_proposal>`;
    const extracted = extractAutomationProposal(text);
    expect(extracted.tagged).toBe(true);
    expect(extracted.visible).toBe(visible);
    expect(extracted.parsed).toEqual({
      taskType: 'reminder',
      scheduleText: '10 分钟后',
      name: '交周报',
      taskText: '提醒我交周报',
    });
  });

  it('strips uppercase proposal tags with the same case-insensitive rules as parsing', () => {
    const visible = '好的，10 分钟后提醒你交周报。';
    const text = `${visible}\n<AUTOMATION_PROPOSAL>\n${JSON.stringify({
      taskType: 'reminder',
      schedule: '10 分钟后',
      name: '交周报',
      taskText: '提醒我交周报',
    })}\n</AUTOMATION_PROPOSAL>`;
    const extracted = extractAutomationProposal(text);
    expect(extracted.tagged).toBe(true);
    expect(extracted.visible).toBe(visible);
    expect(extracted.parsed?.taskText).toBe('提醒我交周报');
    expect(extracted.visible).not.toContain('AUTOMATION_PROPOSAL');
  });

  it('does not rewrite text that has no proposal tag', () => {
    const text = 'hello\n';
    expect(extractAutomationProposal(text)).toEqual({ visible: text, tagged: false });
  });

  it('reads the tag from finalText even when tool blocks make renderText nonempty', () => {
    const visible = '好的，10 分钟后提醒你交周报。';
    const tagged = `${visible}\n<automation_proposal>\n${JSON.stringify({
      schedule: '10 分钟后',
      taskText: '提醒我交周报',
    })}\n</automation_proposal>`;
    const state = {
      ...initialState,
      blocks: [{
        kind: 'tool' as const,
        tool: {
          id: 't1',
          name: 'Bash',
          input: { command: 'true' },
          status: 'done' as const,
          output: 'ok',
        },
      }],
      finalText: tagged,
    };
    const extracted = extractAutomationProposal(proposalTextFromState(state));
    expect(extracted.tagged).toBe(true);
    expect(extracted.parsed?.taskText).toBe('提醒我交周报');
    expect(stripProposalFromState(state).finalText).toBe(visible);
  });

  it('hides an unclosed opener through the end of the reply', () => {
    const extracted = extractAutomationProposal('可见正文\n<automation_proposal>\n{"schedule":');
    expect(extracted.tagged).toBe(true);
    expect(extracted.visible).toBe('可见正文');
    expect(extracted.parsed).toBeUndefined();
  });
});

describe('parseAutomationProposalJson', () => {
  it('defaults taskType to reminder and name to taskText', () => {
    expect(parseAutomationProposalJson(JSON.stringify({
      schedule: 'in 15m',
      taskText: '交周报',
    }))).toEqual({
      taskType: 'reminder',
      scheduleText: 'in 15m',
      name: '交周报',
      taskText: '交周报',
    });
  });

  it('rejects a missing schedule or task text', () => {
    expect(parseAutomationProposalJson('{"taskText":"x"}')).toBeUndefined();
    expect(parseAutomationProposalJson('{"schedule":"in 15m"}')).toBeUndefined();
    expect(parseAutomationProposalJson('not-json')).toBeUndefined();
  });
});

describe('automation proposal instruction', () => {
  it('shows absolute one-shot times and a recurring start prefix', () => {
    expect(AUTOMATION_PROPOSAL_INSTRUCTION).toContain('2026-10-18 15:50');
    expect(AUTOMATION_PROPOSAL_INSTRUCTION).toContain('今天 15:50');
    expect(AUTOMATION_PROPOSAL_INSTRUCTION).toContain('明天 09:00');
    expect(AUTOMATION_PROPOSAL_INSTRUCTION).toContain('从 明天 15:40 起 every 10m 15:40-16:05 until 2026-10-19 16:05');
    expect(AUTOMATION_PROPOSAL_INSTRUCTION).toContain('YYYY-MM-DD HH:MM');
    expect(AUTOMATION_PROPOSAL_INSTRUCTION).toContain('今天/明天/后天 HH:MM');
    expect(AUTOMATION_PROPOSAL_INSTRUCTION).toContain('从 <日期> [HH:MM] 起');
  });
});

describe('shouldHonorAutomationProposal', () => {
  it('rejects bot senders and automation-run scopes', () => {
    const base = { enabled: true, scope: 'oc_group', senderId: 'ou_user' };
    expect(shouldHonorAutomationProposal(base)).toBe(true);
    expect(shouldHonorAutomationProposal({ ...base, senderType: 'app' })).toBe(false);
    expect(shouldHonorAutomationProposal({ ...base, senderType: 'bot' })).toBe(false);
    expect(shouldHonorAutomationProposal({ ...base, senderId: 'ou_bot', botOpenId: 'ou_bot' })).toBe(false);
    expect(shouldHonorAutomationProposal({ ...base, scope: 'auto:1:1' })).toBe(false);
    expect(shouldHonorAutomationProposal({ ...base, scope: 'meeting:abc' })).toBe(false);
    expect(shouldHonorAutomationProposal({ ...base, enabled: false })).toBe(false);
  });
});
