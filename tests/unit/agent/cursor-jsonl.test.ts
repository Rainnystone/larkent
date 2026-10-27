import { describe, expect, it, vi } from 'vitest';
import { CursorJsonlTranslator } from '../../../src/agent/cursor/jsonl';
import type { AgentEvent } from '../../../src/agent/types';
import { log } from '../../../src/core/logger';

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

// Parsing assertions omit activity; D03b replay and core/watchdog tests pin liveness.
function collect(translator: CursorJsonlTranslator, lines: unknown[]): AgentEvent[] {
  return lines.flatMap((line) => translator.translate(line)).filter(event => event.type !== 'liveness');
}

function assistantMessage(text: string) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: SESSION,
  };
}

function textDeltas(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type === 'text');
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

  it('treats connection and retry as known stream-reconnect events, not unknown_event', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const t = new CursorJsonlTranslator();
    const events = collect(t, [
      INIT,
      { type: 'connection', attempt: 1 },
      { type: 'retry', attempt: 2 },
      { type: 'connection' },
      { type: 'retry' },
      RESULT,
    ]);
    expect(events).toEqual([
      { type: 'system', resumeHandle: SESSION, cwd: '/Users/user/project', model: 'Composer 2.5' },
      { type: 'done', resumeHandle: SESSION, terminationReason: 'normal' },
    ]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 0 });
    expect(warn.mock.calls.some((call) => call[0] === 'jsonl' && call[1] === 'unknown_event')).toBe(false);
    expect(info.mock.calls.filter((call) => call[0] === 'jsonl' && call[1] === 'stream-reconnect')).toHaveLength(4);
    info.mockRestore();
    warn.mockRestore();
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
