import { describe, expect, it } from 'vitest';
import { DevinTranscriptTranslator } from '../../../src/agent/devin/transcript';

const text = (value: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });

describe('Devin ACP translation', () => {
  it('preserves paragraph whitespace and code indentation across chunks', () => {
    const t = new DevinTranscriptTranslator();
    expect([...t.translate(text('Intro\n\n```python\n'))]).toEqual([{ type: 'text', delta: 'Intro\n\n```python\n' }]);
    t.translate(text('if True:\n    print("hello")\n```\n'));
    expect([...t.finish('end_turn')]).toEqual([
      { type: 'final_text', content: 'Intro\n\n```python\nif True:\n    print("hello")\n```\n' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('merges late tool input, deduplicates updates and preserves the command', () => {
    const t = new DevinTranscriptTranslator();
    t.translate(text('I will check.'));
    expect([...t.translate({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Run command', kind: 'execute' })]).toEqual([]);
    const use = { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress', rawInput: { command: 'lark-cli im +send --chat-id oc_test' } };
    expect([...t.translate(use)]).toEqual([{ type: 'tool_use', id: 'a', name: 'execute', input: use.rawInput }]);
    expect([...t.translate(use)]).toEqual([]);
    const result = { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', rawOutput: { code: 0, data: { message_id: 'om_test' } } };
    expect([...t.translate(result)]).toEqual([{ type: 'tool_result', id: 'a', output: JSON.stringify(result.rawOutput), isError: false }]);
    expect([...t.translate(result)]).toEqual([]);
    t.translate(text('Finished.'));
    expect([...t.finish('end_turn')][0]).toEqual({ type: 'final_text', content: 'Finished.' });
  });

  it('reports failed tools without ending a turn the model can correct', () => {
    const t = new DevinTranscriptTranslator();
    t.translate({ sessionUpdate: 'tool_call', toolCallId: 'b', kind: 'read', rawInput: { path: '/missing' } });
    expect([...t.translate({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Not found' } }] })]).toEqual([
      { type: 'tool_result', id: 'b', output: 'Not found', isError: true },
    ]);
    t.translate(text('Corrected.'));
    expect([...t.finish('end_turn')].at(-1)).toEqual({ type: 'done', terminationReason: 'normal' });
  });
  it('waits for an actual command when execute input arrives in partial updates', () => {
    const t = new DevinTranscriptTranslator();
    expect(t.translate({ sessionUpdate: 'tool_call', toolCallId: 'late', kind: 'execute', rawInput: {} })).toEqual([]);
    expect(t.translate({ sessionUpdate: 'tool_call_update', toolCallId: 'late', rawInput: { command: '' } })).toEqual([]);
    expect(t.translate({ sessionUpdate: 'tool_call_update', toolCallId: 'late', rawInput: { timeout: 30 } })).toEqual([]);
    expect(t.translate({ sessionUpdate: 'tool_call_update', toolCallId: 'late', rawInput: { command: 'lark-cli auth login' } })).toEqual([
      { type: 'tool_use', id: 'late', name: 'execute', input: { timeout: 30, command: 'lark-cli auth login' } },
    ]);
  });

  it('ignores replayed history including tool events', () => {
    const t = new DevinTranscriptTranslator();
    expect([...t.translate(text('Old answer'), true)]).toEqual([]);
    expect([...t.translate({ sessionUpdate: 'tool_call', toolCallId: 'old', kind: 'execute', rawInput: { command: 'old' } }, true)]).toEqual([]);
    t.translate(text('Current answer'));
    expect([...t.finish('end_turn')][0]).toEqual({ type: 'final_text', content: 'Current answer' });
  });

  it('does not publish pre-tool narration as a final answer', () => {
    const t = new DevinTranscriptTranslator();
    t.translate(text('Starting.'));
    t.translate({ sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'read', rawInput: {} });
    expect([...t.finish('end_turn')]).toEqual([{ type: 'done', terminationReason: 'normal' }]);
  });

  it('fails unsupported terminal reasons and does not emit a second terminal', () => {
    const t = new DevinTranscriptTranslator();
    expect([...t.finish('max_tokens')]).toEqual([expect.objectContaining({ type: 'error', terminationReason: 'failed' })]);
    expect([...t.finish('end_turn')]).toEqual([]);
  });
});
