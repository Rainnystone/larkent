import { describe, expect, it } from 'vitest';
import { CodexJsonlTranslator } from '../../../src/agent/codex/jsonl';
import { KimiJsonlTranslator } from '../../../src/agent/kimi/jsonl';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import { CursorJsonlTranslator } from '../../../src/agent/cursor/jsonl';

// Synthetic legacy compatibility: no claim that D03a captures reuse IDs.
const cases = [
  { kind: 'codex', create: () => new CodexJsonlTranslator(), expected: [{ command: 'first' }, { command: 'second' }], records: [
    { type: 'item.started', item: { id: 'same', type: 'command_execution', command: 'first' } },
    { type: 'item.completed', item: { id: 'same', type: 'command_execution', output: 'first', exit_code: 0 } },
    { type: 'item.started', item: { id: 'same', type: 'command_execution', command: 'second' } },
    { type: 'item.completed', item: { id: 'same', type: 'command_execution', output: 'second', exit_code: 0 } },
  ] },
  { kind: 'kimi', create: () => new KimiJsonlTranslator(), expected: [{ path: 'first' }, { path: 'second' }], records: [
    { role: 'assistant', tool_calls: [{ id: 'same', function: { name: 'Read', arguments: '{"path":"first"}' } }] },
    { role: 'tool', tool_call_id: 'same', content: 'first' },
    { role: 'assistant', tool_calls: [{ id: 'same', function: { name: 'Read', arguments: '{"path":"second"}' } }] },
    { role: 'tool', tool_call_id: 'same', content: 'second' },
  ] },
  { kind: 'grok', create: () => new GrokJsonlTranslator(), expected: [{ path: 'first' }, { path: 'second' }], records: [
    { type: 'tool_call', toolCallId: 'same', toolName: 'read_file', rawInput: { path: 'first' } },
    { type: 'tool_call_update', toolCallId: 'same', status: 'completed', rawOutput: 'first' },
    { type: 'tool_call', toolCallId: 'same', toolName: 'read_file', rawInput: { path: 'second' } },
    { type: 'tool_call_update', toolCallId: 'same', status: 'completed', rawOutput: 'second' },
  ] },
  { kind: 'cursor', create: () => new CursorJsonlTranslator(), expected: [{ path: 'first' }, { path: 'second' }], records: [
    { type: 'tool_call', subtype: 'started', call_id: 'same', tool_call: { function: { name: 'Read', arguments: { path: 'first' } } } },
    { type: 'tool_call', subtype: 'completed', call_id: 'same', tool_call: { function: { name: 'Read', result: { success: 'first' } } } },
    { type: 'tool_call', subtype: 'started', call_id: 'same', tool_call: { function: { name: 'Read', arguments: { path: 'second' } } } },
    { type: 'tool_call', subtype: 'completed', call_id: 'same', tool_call: { function: { name: 'Read', result: { success: 'second' } } } },
  ] },
];

describe('completed tool ID reuse at a new native start', () => {
  it.each(cases)('$kind preserves two ordered pairs and their distinct inputs', ({ create, records, expected }) => {
    const translator = create();
    const events = records.flatMap(raw => translator.translate(raw)).filter(event => event.type === 'tool_use' || event.type === 'tool_result');
    expect(events.map(event => event.type)).toEqual(['tool_use', 'tool_result', 'tool_use', 'tool_result']);
    expect(events.flatMap(event => event.type === 'tool_use' ? [event.input] : [])).toEqual(expected);
    expect(events.flatMap(event => event.type === 'tool_result' ? [event.output] : [])).toEqual(['first', 'second']);
  });
});
