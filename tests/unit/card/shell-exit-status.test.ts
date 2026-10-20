import { describe, expect, it } from 'vitest';
import { CursorJsonlTranslator } from '../../../src/agent/cursor/jsonl';
import { KimiJsonlTranslator } from '../../../src/agent/kimi/jsonl';
import type { AgentEvent } from '../../../src/agent/types';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce } from '../../../src/card/run-state';

const COMMANDS = [
  'node "$LARK_BRIDGE_TOOL_CLIENT" tool',
  'node "$LARK_BRIDGE_TOOL_CLIENT" tool ; ls /nonexistent-synthetic-card-path',
];
const DIAGNOSTIC = 'ls: synthetic missing path';

describe('Cursor shell result cards', () => {
  it.each(['exitCode', 'exit_code'])('uses native numeric %s metadata for folded and compound calls', (field) => {
    for (const command of COMMANDS) {
      expectFailure(cursorEvents(command, { [field]: 2, stderr: DIAGNOSTIC }), command);
    }
  });

  it('keeps a zero exit successful even with stderr text', () => {
    const card = cardFor(cursorEvents(COMMANDS[0]!, { exitCode: 0, stderr: 'synthetic warning' }));
    expect(card).toContain('✅');
    expect(card).not.toContain('❌');
  });
});

// Source-backed synthetic Kimi shell status envelopes, not invented JSON stdout:
// MoonshotAI/kimi-cli@83579fd (0.38) soul/message.py + tools/bash/__init__.py;
// @9ab1286 soul/message.py + tools/shell/__init__.py adds the ERROR: prefix.
describe('Kimi shell result cards', () => {
  it('keeps a non-shell result containing a shell-status example successful', () => {
    const translator = new KimiJsonlTranslator();
    const card = cardFor([
      ...translator.translate({ role: 'assistant', tool_calls: [{
        type: 'function', id: 'read', function: { name: 'ReadFile', arguments: '{"path":"synthetic.txt"}' },
      }] }),
      ...translator.translate({ role: 'tool', tool_call_id: 'read', content: '<system>Command failed with exit code: 2.</system>' }),
    ]);
    expect(card).toContain('✅');
    expect(card).not.toContain('❌');
  });

  it.each(['', 'ERROR: '])('uses the leading %ssystem status for folded and compound failures', (prefix) => {
    for (const command of COMMANDS) {
      const header = `<system>${prefix}Command failed with exit code: 2.</system>`;
      for (const content of [
        `${header}\n${DIAGNOSTIC}`,
        [{ type: 'text', text: header }, { type: 'text', text: DIAGNOSTIC }],
      ]) expectFailure(kimiEvents(command, content), command);
    }
  });

  it.each(['exitCode', 'exit_code'])('keeps successful JSON stdout containing %s as data', (field) => {
    const output = JSON.stringify({ [field]: 2 });
    const card = cardFor(kimiEvents(`printf '%s' '${output}'`, [
      { type: 'text', text: '<system>Command executed successfully.</system>' },
      { type: 'text', text: output },
    ]));
    expect(card).toContain('✅');
    expect(card).not.toContain('❌');
    expect(card).toContain(JSON.stringify(output).slice(1, -1));
  });
});

function cursorEvents(command: string, result: object): AgentEvent[] {
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
}

function kimiEvents(command: string, content: unknown): AgentEvent[] {
  const translator = new KimiJsonlTranslator();
  return [
    ...translator.translate({ role: 'assistant', tool_calls: [{
      type: 'function', id: 'shell', function: { name: 'Shell', arguments: JSON.stringify({ command }) },
    }] }),
    ...translator.translate({ role: 'tool', tool_call_id: 'shell', content }),
  ];
}

function expectFailure(events: AgentEvent[], command: string): void {
  const card = cardFor(events);
  expect(card).toContain('❌');
  expect(card).not.toContain('✅');
  expect(card).toContain('"color":"red"');
  if (command.includes(';')) {
    expect(card).toContain('tool ; ls /nonexistent-synthetic-card-path');
    expect(card).toContain(DIAGNOSTIC);
  }
}

function cardFor(events: AgentEvent[]): string {
  return JSON.stringify(renderCard(events.reduce((state, event) => reduce(state, event), initialState)));
}
