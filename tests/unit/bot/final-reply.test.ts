import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { finalReplyFor } from '../../../src/bot/cot';
import { reduce, seedRunState, type RunState } from '../../../src/card/run-state';
import { renderText } from '../../../src/card/text-renderer';

const ANSWER = 'AG4 完成，群数=1';
const NOTICE = '这次只完成了一部分。';

const GROK_EVENTS: AgentEvent[] = [
  { type: 'system', resumeHandle: 'sess-grok' },
  { type: 'tool_use', id: 'tool-ag4', name: 'Bash', input: { command: 'printf group-count' } },
  { type: 'tool_result', id: 'tool-ag4', output: '1', isError: false },
  { type: 'final_text', content: ANSWER },
  { type: 'done', terminationReason: 'normal' },
];

describe('final reply selection', () => {
  it('keeps a partial notice with finalText when nothing was streamed', () => {
    const state = withNotice(reduceAll(GROK_EVENTS), NOTICE);
    const body = renderText(finalReplyFor(state, { replyMode: 'final-answer', streamed: false })).trim();
    expect(body).toBe(`${ANSWER}\n\n${NOTICE}`);
    expect(body.split(ANSWER)).toHaveLength(2);
  });

  it('drops already-streamed text and notices, leaving finalText once', () => {
    const state = withNotice(reduceAll(GROK_EVENTS), NOTICE);
    const body = renderText(finalReplyFor(state, { replyMode: 'final-answer', streamed: true })).trim();
    expect(body).toBe(ANSWER);
  });

  it('leaves stream-deltas text blocks unchanged', () => {
    const state = reduceAll([
      { type: 'system', resumeHandle: 'sess-claude' },
      { type: 'text', delta: '汇总完成' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const selected = finalReplyFor(state, { replyMode: 'stream-deltas', streamed: false });
    expect(renderText(selected).trim()).toBe('汇总完成');
    expect(selected.blocks).toBe(state.blocks);
  });

});

function reduceAll(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), seedRunState({ currentChatId: 'oc_group' }));
}

function withNotice(state: RunState, notice: string): RunState {
  return {
    ...state,
    blocks: [
      ...state.blocks,
      { kind: 'text', content: notice, streaming: false, notice: true },
    ],
  };
}
