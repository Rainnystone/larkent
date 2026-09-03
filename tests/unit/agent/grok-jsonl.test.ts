import { describe, expect, it } from 'vitest';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import type { AgentEvent } from '../../../src/agent/types';

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const END = {
  type: 'end',
  stopReason: 'end_turn',
  sessionId: SESSION,
  usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
};

function collect(translator: GrokJsonlTranslator, lines: unknown[]): AgentEvent[] {
  return lines.flatMap((line) => translator.translate(JSON.stringify(line)));
}

describe('GrokJsonlTranslator', () => {
  it('maps a plain text run to system + final_text + done', () => {
    const t = new GrokJsonlTranslator();
    const events = collect(t, [{ type: 'text', data: 'OK' }, END]);
    expect(events).toEqual([
      { type: 'system', sessionId: SESSION },
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 2,
      },
      { type: 'final_text', content: 'OK' },
      { type: 'done', sessionId: SESSION, terminationReason: 'normal' },
    ]);
    expect(t.terminalEmitted()).toBe(true);
  });

  it('concatenates incremental text chunks into one final_text', () => {
    const t = new GrokJsonlTranslator();
    const events = collect(t, [
      { type: 'text', data: 'Hel' },
      { type: 'text', data: 'lo' },
      { type: 'end', sessionId: SESSION },
    ]);
    expect(events.find((e) => e.type === 'final_text')).toEqual({
      type: 'final_text',
      content: 'Hello',
    });
  });

  it('drops thoughts and pre-tool commentary, holding only the post-tool answer', () => {
    const t = new GrokJsonlTranslator();
    const events = collect(t, [
      { type: 'thought', data: 'looking' },
      { type: 'text', data: 'Let me check.' },
      {
        type: 'tool_call',
        toolCallId: 'call_1',
        toolName: 'read_file',
        status: 'in_progress',
        rawInput: { path: 'a.ts' },
      },
      {
        type: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed',
        rawOutput: { lines: 3 },
      },
      { type: 'text', data: 'Done.' },
      { type: 'end', sessionId: SESSION },
    ]);
    expect(events).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'tool_result', id: 'call_1', output: '{"lines":3}', isError: false },
      { type: 'system', sessionId: SESSION },
      { type: 'final_text', content: 'Done.' },
      { type: 'done', sessionId: SESSION, terminationReason: 'normal' },
    ]);
  });

  it('treats a failed tool_call_update as isError', () => {
    const t = new GrokJsonlTranslator();
    const events = collect(t, [
      {
        type: 'tool_call',
        toolCallId: 'call_1',
        toolName: 'run_terminal_cmd',
        status: 'in_progress',
        rawInput: { command: 'false' },
      },
      {
        type: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'failed',
        rawOutput: { error: 'exit 1' },
      },
    ]);
    expect(events[1]).toEqual({
      type: 'tool_result',
      id: 'call_1',
      output: '{"error":"exit 1"}',
      isError: true,
    });
  });

  it('maps an error line to a terminal error event', () => {
    const t = new GrokJsonlTranslator();
    expect(collect(t, [{ type: 'error', message: 'auth failed' }])).toEqual([
      { type: 'error', message: 'auth failed', terminationReason: 'failed' },
    ]);
    expect(t.terminalEmitted()).toBe(true);
  });

  it('ignores unknown event types without throwing', () => {
    const t = new GrokJsonlTranslator();
    expect(collect(t, [{ type: 'plan', entries: [] }, { type: 'available_commands' }])).toEqual([]);
    expect(t.protocolDrift().unknownEvents).toBe(0);
    collect(t, [{ type: 'not-a-real-event' }]);
    expect(t.protocolDrift().unknownEvents).toBe(1);
  });

  it('finish(failed) surfaces an error when the stream had no end line', () => {
    const t = new GrokJsonlTranslator();
    expect(t.finish()).toEqual([
      {
        type: 'error',
        message: 'grok stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
  });
});
