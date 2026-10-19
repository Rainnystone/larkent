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
/** Worked example: UTF-8 of `中文{"ok":true}` as Grok sends it on the wire. */
const BASH_UTF8_TEXT = '中文{"ok":true}';
const BASH_UTF8_BYTES = [228, 184, 173, 230, 150, 135, 123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125];

function collect(translator: GrokJsonlTranslator, lines: unknown[]): AgentEvent[] {
  return lines.flatMap((line) => translator.translate(line));
}

describe('GrokJsonlTranslator', () => {
  it('maps a plain text run to system + final_text + done', () => {
    const t = new GrokJsonlTranslator();
    const events = collect(t, [{ type: 'text', data: 'OK' }, END]);
    expect(events).toEqual([
      { type: 'system', resumeHandle: SESSION },
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 2,
      },
      { type: 'final_text', content: 'OK' },
      { type: 'done', resumeHandle: SESSION, terminationReason: 'normal' },
    ]);
    expect(t.terminalEmitted()).toBe(true);
  });

  it('drops a final answer that is only a model control token', () => {
    const eos = new GrokJsonlTranslator();
    const eosEvents = collect(eos, [
      { type: 'text', data: ' <|eos|>\n' },
      { type: 'end', sessionId: SESSION },
    ]);
    expect(eosEvents.some((event) => event.type === 'final_text' || event.type === 'text')).toBe(false);
    expect(JSON.stringify(eosEvents)).not.toContain('<|eos|>');
    expect(eosEvents.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });

    const sibling = new GrokJsonlTranslator();
    const siblingEvents = collect(sibling, [
      { type: 'text', data: '<|end' },
      { type: 'text', data: '_of_turn|>  ' },
      END,
    ]);
    expect(siblingEvents.some((event) => event.type === 'final_text' || event.type === 'text')).toBe(false);
    expect(JSON.stringify(siblingEvents)).not.toContain('<|end_of_turn|>');

    const kept = new GrokJsonlTranslator();
    const keptEvents = collect(kept, [
      { type: 'text', data: 'see <|eos|> in the answer' },
      { type: 'end', sessionId: SESSION },
    ]);
    expect(keptEvents.find((event) => event.type === 'final_text')).toEqual({
      type: 'final_text',
      content: 'see <|eos|> in the answer',
    });
  });

  it('does not prefix a failed finish with a control-token-only buffer', () => {
    const t = new GrokJsonlTranslator();
    t.translate({ type: 'text', data: '<|eos|>' });
    const events = t.finish();
    expect(events).toEqual([
      {
        type: 'error',
        message: 'grok stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('<|eos|>');
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
      { type: 'system', resumeHandle: SESSION },
      { type: 'final_text', content: 'Done.' },
      { type: 'done', resumeHandle: SESSION, terminationReason: 'normal' },
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

  it('decodes a Bash wrapper whose output is utf-8 bytes of 中文+JSON', () => {
    expect(toolResultOutput({ type: 'Bash', output: BASH_UTF8_BYTES })).toBe(BASH_UTF8_TEXT);
    expect(toolResultOutput({ content: BASH_UTF8_BYTES })).toBe(BASH_UTF8_TEXT);
  });

  it('decodes a utf-8 byte number array tool payload', () => {
    expect(toolResultOutput(BASH_UTF8_BYTES)).toBe(BASH_UTF8_TEXT);
  });

  it('decodes a Uint8Array tool payload as utf-8 text', () => {
    expect(toolResultOutput(Uint8Array.from(BASH_UTF8_BYTES))).toBe(BASH_UTF8_TEXT);
  });

  it('decodes a Buffer tool payload as utf-8 text', () => {
    expect(toolResultOutput(Buffer.from(BASH_UTF8_BYTES))).toBe(BASH_UTF8_TEXT);
  });

  it('leaves string tool output unchanged', () => {
    expect(toolResultOutput(BASH_UTF8_TEXT)).toBe(BASH_UTF8_TEXT);
  });

  it('keeps ordinary tool objects as JSON', () => {
    expect(toolResultOutput({ lines: 3 })).toBe('{"lines":3}');
    expect(toolResultOutput({ type: 'Bash', output: 'already text' })).toBe(
      '{"type":"Bash","output":"already text"}',
    );
  });

  it('replaces illegal utf-8 sequences instead of throwing', () => {
    expect(toolResultOutput([0xff])).toBe('\uFFFD');
  });

  it('does not treat non-byte number arrays as utf-8', () => {
    expect(toolResultOutput([256, 1])).toBe('[256,1]');
    expect(toolResultOutput([-1, 0])).toBe('[-1,0]');
    expect(toolResultOutput({ type: 'Bash', output: [256, 1] })).toBe(
      '{"type":"Bash","output":[256,1]}',
    );
    expect(toolResultOutput({ type: 'Bash', output: [-1, 0] })).toBe(
      '{"type":"Bash","output":[-1,0]}',
    );
  });
});

function toolResultOutput(rawOutput: unknown): string | undefined {
  const t = new GrokJsonlTranslator();
  const events = collect(t, [
    {
      type: 'tool_call',
      toolCallId: 'call_1',
      toolName: 'Bash',
      status: 'in_progress',
      rawInput: { command: 'bridge-tool' },
    },
    {
      type: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      rawOutput,
    },
  ]);
  const result = events.find((event) => event.type === 'tool_result');
  return result && result.type === 'tool_result' ? result.output : undefined;
}
