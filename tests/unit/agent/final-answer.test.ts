import { describe, expect, it } from 'vitest';
import { FinalAnswerCore } from '../../../src/agent/final-answer/core';

// Approved D04 seam: normalized translator inputs, observed AgentEvents.
describe('answer hold-back', () => {
  it('holds an answer until success and ignores late input', () => {
    const core = new FinalAnswerCore({ accumulation: 'message', preTool: 'progress', separator: 'none' });
    expect(core.accept({ type: 'answer', text: 'Answer' })).toEqual([{ type: 'liveness' }]);
    expect(core.accept({ type: 'done', terminationReason: 'normal' })).toEqual([
      { type: 'final_text', content: 'Answer' }, { type: 'done', terminationReason: 'normal' },
    ]);
    expect(core.accept({ type: 'answer', text: 'Late' })).toEqual([]);
  });
  it('stops with progress, closes unfinished tools, and never posts a final answer', () => {
    const core = new FinalAnswerCore({ accumulation: 'message', preTool: 'progress', separator: 'none' });
    core.accept({ type: 'tool_use', id: 'call', name: 'Shell', input: {} });
    core.accept({ type: 'answer', text: 'Partial' });
    expect(core.accept({ type: 'done', terminationReason: 'interrupted' })).toEqual([
      { type: 'text', delta: 'Partial', heldBack: true },
      { type: 'tool_result', id: 'call', output: 'Tool did not complete before the run ended.', isError: true },
      { type: 'done', terminationReason: 'interrupted' },
    ]);
  });
  it.each([
    ['discard', [], []],
    ['progress', [{ type: 'text', delta: 'Plan\n\n' }], []],
    ['fallback', [{ type: 'text', delta: 'Plan\n\n' }], [{ type: 'final_text', content: 'Plan' }]],
  ] as const)('classifies pre-tool text using the %s policy', (preTool, progress, answer) => {
    const core = new FinalAnswerCore({ accumulation: 'delta', preTool, separator: 'line' });
    core.accept({ type: 'answer', text: 'Pl' });
    core.accept({ type: 'answer', text: 'an' });
    expect([...core.accept({ type: 'boundary' }), ...core.accept({ type: 'tool_use', id: 'call', name: 'Shell', input: {} })]).toEqual([
      ...progress, { type: 'tool_use', id: 'call', name: 'Shell', input: {} },
    ]);
    core.accept({ type: 'tool_result', id: 'call', output: 'ok', isError: false });
    expect(core.accept({ type: 'done', terminationReason: 'normal' })).toEqual([
      ...answer, { type: 'done', terminationReason: 'normal' },
    ]);
  });
  it('deduplicates complete messages and flushes progress before an error', () => {
    const core = new FinalAnswerCore({ accumulation: 'message', preTool: 'progress', separator: 'paragraph' });
    core.accept({ type: 'answer', text: 'First' });
    expect(core.accept({ type: 'answer', text: 'First' })).toEqual([{ type: 'liveness' }]);
    expect(core.accept({ type: 'answer', text: 'Second' })).toEqual([
      { type: 'text', delta: 'First\n\n' }, { type: 'liveness' },
    ]);
    expect(core.accept({ type: 'error', message: 'failure', terminationReason: 'failed' })).toEqual([
      { type: 'text', delta: 'Second\n\n' }, { type: 'error', message: 'failure', terminationReason: 'failed' },
    ]);
  });
  it('scrubs authoritative final content and pairs orphan results without inventing a native tool', () => {
    const core = new FinalAnswerCore({ accumulation: 'delta', preTool: 'progress', separator: 'line', clean: text => text.replace('<envelope>', '') });
    expect(core.accept({ type: 'tool_result', id: 'orphan', output: 'ok', isError: false })).toEqual([{ type: 'liveness' }]);
    core.accept({ type: 'answer', text: 'Held' });
    expect(core.accept({ type: 'complete', terminal: { type: 'done', terminationReason: 'normal' }, content: '<envelope>Answer' })).toEqual([
      { type: 'final_text', content: 'Answer' }, { type: 'done', terminationReason: 'normal' },
    ]);
    expect(core.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 1 });
  });
  it('keeps the last complete message under the discard policy', () => {
    const core = new FinalAnswerCore({ accumulation: 'message', preTool: 'discard', separator: 'paragraph' });
    core.accept({ type: 'answer', text: 'Plan' });
    expect(core.accept({ type: 'answer', text: 'Answer' })).toEqual([{ type: 'liveness' }]);
    expect(core.accept({ type: 'done', terminationReason: 'normal' })).toEqual([
      { type: 'final_text', content: 'Answer' }, { type: 'done', terminationReason: 'normal' },
    ]);
  });
  it('preserves whitespace across chunks and flushes when a message id changes', () => {
    const core = new FinalAnswerCore({ accumulation: 'delta', preTool: 'progress', separator: 'line' });
    core.accept({ type: 'answer', text: 'Intro\n', messageId: 'one' });
    core.accept({ type: 'answer', text: '    code\n', messageId: 'one' });
    expect(core.accept({ type: 'answer', text: 'Answer', messageId: 'two' })).toEqual([
      { type: 'text', delta: 'Intro\n    code\n' }, { type: 'liveness' },
    ]);
    expect(core.accept({ type: 'done', terminationReason: 'normal' })).toEqual([
      { type: 'final_text', content: 'Answer' }, { type: 'done', terminationReason: 'normal' },
    ]);
  });
  it('pairs each call once and fails the remaining call before an error', () => {
    const core = new FinalAnswerCore({ accumulation: 'message', preTool: 'progress', separator: 'paragraph' });
    core.accept({ type: 'tool_use', id: 'one', name: 'Shell', input: {} });
    expect(core.accept({ type: 'tool_use', id: 'one', name: 'Shell', input: {} })).toEqual([{ type: 'liveness' }]);
    core.accept({ type: 'tool_result', id: 'one', output: 'ok', isError: false });
    expect(core.accept({ type: 'tool_result', id: 'one', output: 'duplicate', isError: false })).toEqual([{ type: 'liveness' }]);
    core.accept({ type: 'tool_use', id: 'two', name: 'Read', input: {} });
    expect(core.accept({ type: 'error', message: 'lost', terminationReason: 'failed' })).toEqual([
      { type: 'tool_result', id: 'two', output: 'Tool did not complete before the run ended.', isError: true },
      { type: 'error', message: 'lost', terminationReason: 'failed' },
    ]);
  });
  it('does not manufacture an answer for empty success', () => {
    const core = new FinalAnswerCore({ accumulation: 'delta', preTool: 'progress', separator: 'line' });
    expect(core.accept({ type: 'done', terminationReason: 'normal' })).toEqual([{ type: 'done', terminationReason: 'normal' }]);
  });
  it.each(['   ', '<|eos|>'])('keeps the stopped fallback when the post-tool segment is %j', text => {
    const core = new FinalAnswerCore({ accumulation: 'delta', preTool: 'fallback', separator: 'line', hasAnswer: text => text.trim() !== '' && text.trim() !== '<|eos|>' });
    core.accept({ type: 'answer', text: 'Checking' });
    core.accept({ type: 'boundary' });
    core.accept({ type: 'tool_use', id: 'one', name: 'Read', input: {} });
    core.accept({ type: 'tool_result', id: 'one', output: 'ok', isError: false });
    core.accept({ type: 'answer', text });
    expect(core.accept({ type: 'done', terminationReason: 'interrupted' })).toEqual([
      { type: 'text', delta: 'Checking', heldBack: true }, { type: 'done', terminationReason: 'interrupted' },
    ]);
  });
});
