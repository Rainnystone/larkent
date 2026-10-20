import { describe, expect, it } from 'vitest';
import { CursorJsonlTranslator } from '../../../src/agent/cursor/jsonl';
import { KimiJsonlTranslator } from '../../../src/agent/kimi/jsonl';
import type { AgentEvent } from '../../../src/agent/types';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce } from '../../../src/card/run-state';

// Synthetic native-result envelopes: test explicit metadata, never infer status
// from stderr wording or from JSON examples mentioned in plain output text.
const runtimes = [
  {
    name: 'Cursor',
    events(command: string, result: object): AgentEvent[] {
      const translator = new CursorJsonlTranslator();
      return [
        ...translator.translate({
          type: 'tool_call', subtype: 'started', call_id: 'shell',
          tool_call: { shellToolCall: { args: { command } } },
        }),
        ...translator.translate({
          type: 'tool_call', subtype: 'completed', call_id: 'shell',
          tool_call: { shellToolCall: { args: { command }, result: { success: result } } },
        }),
      ];
    },
  },
  {
    name: 'Kimi',
    events(command: string, result: object): AgentEvent[] {
      const translator = new KimiJsonlTranslator();
      return [
        ...translator.translate({ role: 'assistant', tool_calls: [{
          type: 'function', id: 'shell', function: { name: 'Shell', arguments: JSON.stringify({ command }) },
        }] }),
        ...translator.translate({ role: 'tool', tool_call_id: 'shell', content: JSON.stringify(result) }),
      ];
    },
  },
];

describe.each(runtimes)('$name shell result cards', ({ events }) => {
  it.each([
    ['exitCode', 'node "$LARK_BRIDGE_TOOL_CLIENT" tool'],
    ['exit_code', 'node "$LARK_BRIDGE_TOOL_CLIENT" tool'],
    ['exitCode', 'node "$LARK_BRIDGE_TOOL_CLIENT" tool ; ls /nonexistent-synthetic-card-path'],
    ['exit_code', 'node "$LARK_BRIDGE_TOOL_CLIENT" tool ; ls /nonexistent-synthetic-card-path'],
  ])('shows nonzero %s as failure for %s', (field, command) => {
    const card = cardFor(events(command, { [field]: 2, stderr: 'ls: synthetic missing path' }));

    expect(card).toContain('❌');
    expect(card).not.toContain('✅');
    expect(card).toContain('"color":"red"');
    if (command.includes(';')) {
      expect(card).toContain('tool ; ls /nonexistent-synthetic-card-path');
      expect(card).toContain('ls: synthetic missing path');
    }
  });

  it('keeps a zero exit successful even with stderr text', () => {
    const card = cardFor(events('node "$LARK_BRIDGE_TOOL_CLIENT" tool', { exitCode: 0, stderr: 'synthetic warning' }));
    expect(card).toContain('✅');
    expect(card).not.toContain('❌');
  });
});

it('does not interpret plain output text or non-shell data as shell exit metadata', () => {
  for (const [name, output] of [
    ['Bash', 'example: {"exitCode":2}'],
    ['Read', '{"exitCode":2,"stderr":"example data"}'],
  ]) {
    const card = cardFor([
      { type: 'tool_use', id: 'shell', name: name!, input: {} },
      { type: 'tool_result', id: 'shell', output: output!, isError: false },
    ]);
    expect(card).toContain('✅');
    expect(card).not.toContain('❌');
  }
});

function cardFor(events: AgentEvent[]): string {
  return JSON.stringify(renderCard(events.reduce((state, event) => reduce(state, event), initialState)));
}
