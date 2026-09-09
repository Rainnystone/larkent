import { describe, expect, it } from 'vitest';
import { CursorJsonlTranslator } from '../../../src/agent/cursor/jsonl';
import type { AgentEvent } from '../../../src/agent/types';

const SESSION = 'c6b62c6f-7ead-4fd6-9922-e952131177ff';

const INIT = {
  type: 'system',
  subtype: 'init',
  apiKeySource: 'login',
  cwd: '/Users/user/project',
  session_id: SESSION,
  model: 'Composer 2.5',
  permissionMode: 'default',
};

const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1234,
  result: 'I will read the fileDone',
  session_id: SESSION,
};

function collect(translator: CursorJsonlTranslator, lines: unknown[]): AgentEvent[] {
  return lines.flatMap((line) => translator.translate(line));
}

describe('CursorJsonlTranslator', () => {
  it('maps a plain text run to system + final_text + done from the result line', () => {
    const t = new CursorJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
        session_id: SESSION,
      },
      RESULT,
    ]);
    expect(events).toEqual([
      { type: 'system', resumeHandle: SESSION, cwd: '/Users/user/project', model: 'Composer 2.5' },
      { type: 'final_text', content: 'OK' },
      { type: 'done', resumeHandle: SESSION, terminationReason: 'normal' },
    ]);
    expect(t.terminalEmitted()).toBe(true);
  });

  it('does not use result.result as the reply body', () => {
    const t = new CursorJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Last message' }] },
        session_id: SESSION,
      },
      { ...RESULT, result: 'concatenatedjunk' },
    ]);
    const final = events.find((e) => e.type === 'final_text');
    expect(final).toEqual({ type: 'final_text', content: 'Last message' });
  });

  it('maps tool calls and results, holding the last assistant text as final', () => {
    const t = new CursorJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool_1',
        tool_call: { readToolCall: { args: { path: 'README.md' } } },
        session_id: SESSION,
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tool_1',
        tool_call: {
          readToolCall: {
            args: { path: 'README.md' },
            result: { success: { content: '# Project', totalLines: 1 } },
          },
        },
        session_id: SESSION,
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The command printed hi.' }],
        },
        session_id: SESSION,
      },
      RESULT,
    ]);
    expect(events).toEqual([
      { type: 'system', resumeHandle: SESSION, cwd: '/Users/user/project', model: 'Composer 2.5' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: 'README.md' } },
      {
        type: 'tool_result',
        id: 'tool_1',
        output: JSON.stringify({ content: '# Project', totalLines: 1 }),
        isError: false,
      },
      { type: 'final_text', content: 'The command printed hi.' },
      { type: 'done', resumeHandle: SESSION, terminationReason: 'normal' },
    ]);
  });

  it('streams intermediate assistant messages as text deltas', () => {
    const t = new CursorJsonlTranslator();
    const events = collect(t, [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }] },
      },
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool_1',
        tool_call: { writeToolCall: { args: { path: 'summary.txt', fileText: 'x' } } },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tool_1',
        tool_call: {
          writeToolCall: {
            args: { path: 'summary.txt' },
            result: { success: { path: '/tmp/summary.txt', linesCreated: 1 } },
          },
        },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      },
      RESULT,
    ]);
    expect(events).toEqual([
      { type: 'text', delta: 'Let me check.\n\n' },
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'Write',
        input: { path: 'summary.txt', fileText: 'x' },
      },
      {
        type: 'tool_result',
        id: 'tool_1',
        output: JSON.stringify({ path: '/tmp/summary.txt', linesCreated: 1 }),
        isError: false,
      },
      { type: 'final_text', content: 'Done.' },
      { type: 'done', resumeHandle: SESSION, terminationReason: 'normal' },
    ]);
  });

  it('maps function-shaped tool calls', () => {
    const t = new CursorJsonlTranslator();
    const events = collect(t, [
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool_fn',
        tool_call: { function: { name: 'Bash', arguments: '{"command":"echo hi"}' } },
      },
    ]);
    expect(events).toEqual([
      { type: 'tool_use', id: 'tool_fn', name: 'Bash', input: { command: 'echo hi' } },
    ]);
  });

  it('ignores user echo lines and unknown types while counting drift', () => {
    const t = new CursorJsonlTranslator();
    expect(
      collect(t, [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'future_event' },
        { not: 'a record' },
        'garbage',
      ]),
    ).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 1, anomalies: 2 });
  });

  it('ignores thinking lines without counting them as protocol drift', () => {
    const t = new CursorJsonlTranslator();
    const events = collect(t, [
      INIT,
      { type: 'thinking' },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
        session_id: SESSION,
      },
      { type: 'thinking' },
      RESULT,
    ]);
    expect(events).toEqual([
      { type: 'system', resumeHandle: SESSION, cwd: '/Users/user/project', model: 'Composer 2.5' },
      { type: 'final_text', content: 'OK' },
      { type: 'done', resumeHandle: SESSION, terminationReason: 'normal' },
    ]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 0 });
  });

  it('finish(failed) surfaces an error when the stream never reached result', () => {
    const t = new CursorJsonlTranslator();
    expect([...collect(t, [INIT]), ...t.finish()]).toEqual([
      { type: 'system', resumeHandle: SESSION, cwd: '/Users/user/project', model: 'Composer 2.5' },
      {
        type: 'error',
        message: 'cursor stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
  });

  it('fail() emits a truncated error event once', () => {
    const t = new CursorJsonlTranslator();
    const message = 'x'.repeat(5000);
    const events = t.fail(message);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message: string }).message).toHaveLength(4096);
    expect(t.fail('again')).toEqual([]);
  });
});
