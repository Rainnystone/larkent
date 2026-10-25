import { describe, expect, it } from 'vitest';
import { DevinTranscriptTranslator } from '../../../src/agent/devin/transcript';

const text = (value: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });

describe('Devin ACP translation', () => {
  it('preserves paragraph whitespace and code indentation across chunks', () => {
    const t = new DevinTranscriptTranslator();
    expect([...t.translate(text('Intro\n\n```python\n'))]).toEqual([]);
    expect([...t.translate(text('if True:\n    print("hello")\n```\n'))]).toEqual([]);
    expect([...t.finish('end_turn')]).toEqual([
      { type: 'final_text', content: 'Intro\n\n```python\nif True:\n    print("hello")\n```\n' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('merges late tool input, deduplicates updates and preserves the command', () => {
    const t = new DevinTranscriptTranslator();
    t.translate(text('I will check.'));
    expect([...t.translate({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Run command', kind: 'execute' })]).toEqual([
      { type: 'text', delta: 'I will check.\n\n' },
    ]);
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
    expect([...t.translate({ sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'read', rawInput: {} })]).toEqual([
      { type: 'text', delta: 'Starting.\n\n' },
      { type: 'tool_use', id: 'c', name: 'read', input: {} },
    ]);
    expect([...t.finish('end_turn')]).toEqual([{ type: 'done', terminationReason: 'normal' }]);
  });

  it('holds back the answer and emits it once as final_text at end_turn', () => {
    const t = new DevinTranscriptTranslator();
    expect([...t.translate(text('The answer '))]).toEqual([]);
    expect([...t.translate(text('is 4.'))]).toEqual([]);
    expect([...t.finish('end_turn')]).toEqual([
      { type: 'final_text', content: 'The answer is 4.' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('flushes the previous message as progress text when the message id changes', () => {
    const t = new DevinTranscriptTranslator();
    const chunk = (value: string, id: string) => ({ ...text(value), _meta: { 'cognition.ai/messageId': id } });
    expect([...t.translate(chunk('First ', 'm1'))]).toEqual([]);
    expect([...t.translate(chunk('thought.', 'm1'))]).toEqual([]);
    expect([...t.translate(chunk('Second.', 'm2'))]).toEqual([{ type: 'text', delta: 'First thought.\n\n' }]);
    expect([...t.finish('end_turn')]).toEqual([
      { type: 'final_text', content: 'Second.' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('flushes held-back text as progress on cancel and withholds final_text', () => {
    const t = new DevinTranscriptTranslator();
    t.translate(text('Partial answer'));
    expect([...t.finish('cancelled')]).toEqual([
      { type: 'text', delta: 'Partial answer\n\n' },
      { type: 'done', terminationReason: 'interrupted' },
    ]);
  });

  it('flushes held-back text before the error on failure', () => {
    const t = new DevinTranscriptTranslator();
    t.translate(text('Partial answer'));
    expect([...t.fail(new Error('connection lost'))]).toEqual([
      { type: 'text', delta: 'Partial answer\n\n' },
      { type: 'error', message: 'connection lost', terminationReason: 'failed' },
    ]);
    expect([...t.finish('end_turn')]).toEqual([]);
  });

  it('emits no final_text for an empty answer', () => {
    const t = new DevinTranscriptTranslator();
    expect([...t.finish('end_turn')]).toEqual([{ type: 'done', terminationReason: 'normal' }]);
  });

  it('fails unsupported terminal reasons and does not emit a second terminal', () => {
    const t = new DevinTranscriptTranslator();
    expect([...t.finish('max_tokens')]).toEqual([expect.objectContaining({ type: 'error', terminationReason: 'failed' })]);
    expect([...t.finish('end_turn')]).toEqual([]);
  });
});
