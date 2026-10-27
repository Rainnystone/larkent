import { describe, expect, it } from 'vitest';
import { AntigravityJsonlTranslator } from '../../../src/agent/antigravity/jsonl';
import { CodexJsonlTranslator } from '../../../src/agent/codex/jsonl';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import { KimiJsonlTranslator } from '../../../src/agent/kimi/jsonl';
import { DevinTranscriptTranslator } from '../../../src/agent/devin/transcript';

// Synthetic legacy characterization, not a claim that D03a contains this ordering.
describe('protocol parsing retains the legacy result boundary', () => {
  it('Codex releases text received during a tool before its result', () => {
    const translator = new CodexJsonlTranslator();
    translator.translate({ type: 'item.started', item: { type: 'command_execution', id: 'one', command: 'echo ok' } });
    translator.translate({ type: 'agent_message', message: 'Still checking' });
    expect(translator.translate({ type: 'item.completed', item: { type: 'command_execution', id: 'one', output: 'ok', exit_code: 0 } })).toEqual([
      { type: 'text', delta: 'Still checking' }, { type: 'tool_result', id: 'one', output: 'ok', isError: false },
    ]);
    expect(translator.translate({ type: 'turn.completed' }).some(event => event.type === 'final_text')).toBe(false);
  });
  it('Kimi releases text received during a tool before its result', () => {
    const translator = new KimiJsonlTranslator();
    translator.translate({ role: 'assistant', tool_calls: [{ id: 'one', function: { name: 'Bash', arguments: '{}' } }] });
    translator.translate({ role: 'assistant', content: 'Still checking' });
    expect(translator.translate({ role: 'tool', tool_call_id: 'one', content: 'ok' })).toEqual([
      { type: 'text', delta: 'Still checking\n\n' }, { type: 'tool_result', id: 'one', output: 'ok', isError: false },
    ]);
    expect(translator.finish('normal').some(event => event.type === 'final_text')).toBe(false);
  });
  it('Devin preserves replacement array input instead of merging it as an object', () => {
    const translator = new DevinTranscriptTranslator();
    translator.translate({ sessionUpdate: 'tool_call', toolCallId: 'one', kind: 'execute', rawInput: {} });
    expect(translator.translate({ sessionUpdate: 'tool_call_update', toolCallId: 'one', rawInput: ['echo', 'ok'] })).toContainEqual({
      type: 'tool_use', id: 'one', name: 'execute', input: ['echo', 'ok'],
    });
  });
  it('preserves Grok whitespace-only successful and failed tails from the baseline', () => {
    const success = new GrokJsonlTranslator();
    success.translate({ type: 'text', data: ' \n' });
    expect(success.finish('normal')).toEqual([
      { type: 'final_text', content: ' \n' }, { type: 'done', terminationReason: 'normal' },
    ]);
    const failure = new GrokJsonlTranslator();
    failure.translate({ type: 'text', data: ' \n' });
    expect(failure.fail('lost')).toEqual([
      { type: 'text', delta: ' \n' }, { type: 'error', message: 'lost', terminationReason: 'failed' },
    ]);
  });
  it('preserves Antigravity explicit successful EOF as a final answer', () => {
    const translator = new AntigravityJsonlTranslator();
    translator.translate({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Answer' } });
    expect(translator.finish('normal')).toEqual([
      { type: 'final_text', content: 'Answer' }, { type: 'done', terminationReason: 'normal' },
    ]);
  });
});
