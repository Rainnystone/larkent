import { describe, expect, it } from 'vitest';
import { KimiJsonlTranslator } from '../../../src/agent/kimi/jsonl';
import type { AgentEvent } from '../../../src/agent/types';

// Real lines captured from kimi 0.38.0 `kimi -p ... --output-format stream-json`.
const VERSION_LINE = { role: 'meta', type: 'system.version', version: '0.38.0' };
const RESUME_HINT = {
  role: 'meta',
  type: 'session.resume_hint',
  session_id: 'session_00000000-0000-4000-8000-000000000000',
  command: 'kimi -r session_00000000-0000-4000-8000-000000000000',
  content: 'To resume this session: kimi -r session_00000000-0000-4000-8000-000000000000',
};

function collect(translator: KimiJsonlTranslator, lines: unknown[]): AgentEvent[] {
  return lines.flatMap((line) => translator.translate(line));
}

describe('KimiJsonlTranslator', () => {
  it('maps a plain text run to system + final_text + done', () => {
    const t = new KimiJsonlTranslator();
    const events = [
      ...collect(t, [VERSION_LINE, { role: 'assistant', content: 'OK' }, RESUME_HINT]),
      ...t.finish('normal'),
    ];
    expect(events).toEqual([
      { type: 'system', resumeHandle: 'session_00000000-0000-4000-8000-000000000000' },
      {
        type: 'final_text',
        content: 'OK',
      },
      {
        type: 'done',
        resumeHandle: 'session_00000000-0000-4000-8000-000000000000',
        terminationReason: 'normal',
      },
    ]);
    expect(t.terminalEmitted()).toBe(true);
  });

  it('maps tool calls and results, holding the last assistant text as final', () => {
    const t = new KimiJsonlTranslator();
    const events = [
      ...collect(t, [
        VERSION_LINE,
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              id: 'tool_1',
              function: { name: 'Bash', arguments: '{"command":"echo hi"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'tool_1', content: 'hi\n' },
        { role: 'assistant', content: 'The command printed hi.' },
        RESUME_HINT,
      ]),
      ...t.finish('normal'),
    ];
    expect(events).toEqual([
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'Bash',
        input: { command: 'echo hi' },
      },
      { type: 'tool_result', id: 'tool_1', output: 'hi\n', isError: false },
      { type: 'system', resumeHandle: 'session_00000000-0000-4000-8000-000000000000' },
      { type: 'final_text', content: 'The command printed hi.' },
      {
        type: 'done',
        resumeHandle: 'session_00000000-0000-4000-8000-000000000000',
        terminationReason: 'normal',
      },
    ]);
  });

  it('streams intermediate assistant messages as text deltas', () => {
    const t = new KimiJsonlTranslator();
    const events = [
      ...collect(t, [
        { role: 'assistant', content: 'Let me check.' },
        {
          role: 'assistant',
          tool_calls: [
            { type: 'function', id: 'tool_1', function: { name: 'Read', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'tool_1', content: 'file body' },
        { role: 'assistant', content: 'Done.' },
        RESUME_HINT,
      ]),
      ...t.finish('normal'),
    ];
    expect(events).toEqual([
      { type: 'text', delta: 'Let me check.\n\n' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
      { type: 'tool_result', id: 'tool_1', output: 'file body', isError: false },
      { type: 'system', resumeHandle: 'session_00000000-0000-4000-8000-000000000000' },
      { type: 'final_text', content: 'Done.' },
      {
        type: 'done',
        resumeHandle: 'session_00000000-0000-4000-8000-000000000000',
        terminationReason: 'normal',
      },
    ]);
  });

  it('dedupes an identical assistant message repeat', () => {
    const t = new KimiJsonlTranslator();
    const events = [
      ...collect(t, [
        { role: 'assistant', content: 'same' },
        { role: 'assistant', content: 'same' },
        RESUME_HINT,
      ]),
      ...t.finish('normal'),
    ];
    expect(events.filter((e) => e.type !== 'system' && e.type !== 'done')).toEqual([
      { type: 'final_text', content: 'same' },
    ]);
  });

  it('keeps unparseable tool arguments as raw text', () => {
    const t = new KimiJsonlTranslator();
    const events = collect(t, [
      {
        role: 'assistant',
        tool_calls: [
          { type: 'function', id: 'tool_1', function: { name: 'Bash', arguments: '{broken' } },
        ],
      },
    ]);
    expect(events).toEqual([
      { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { raw: '{broken' } },
    ]);
  });

  it('finish(failed) surfaces an error and carries no session when none was seen', () => {
    const t = new KimiJsonlTranslator();
    expect([...collect(t, [VERSION_LINE]), ...t.finish()]).toEqual([
      {
        type: 'error',
        message: 'kimi stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
  });

  it('finish(interrupted) flushes pending text and marks done interrupted', () => {
    const t = new KimiJsonlTranslator();
    const events = [
      ...collect(t, [{ role: 'assistant', content: 'partial' }, RESUME_HINT]),
      ...t.finish('interrupted'),
    ];
    expect(events).toEqual([
      { type: 'system', resumeHandle: 'session_00000000-0000-4000-8000-000000000000' },
      { type: 'final_text', content: 'partial' },
      {
        type: 'done',
        resumeHandle: 'session_00000000-0000-4000-8000-000000000000',
        terminationReason: 'interrupted',
      },
    ]);
  });

  it('ignores unknown roles and meta types while counting drift', () => {
    const t = new KimiJsonlTranslator();
    expect(
      collect(t, [
        { role: 'system', content: 'nope' },
        { role: 'meta', type: 'some.future.meta' },
        { not: 'a record line' },
        'garbage',
      ]),
    ).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 2, anomalies: 2 });
  });

  it('fail() emits a truncated error event once', () => {
    const t = new KimiJsonlTranslator();
    const message = 'x'.repeat(5000);
    const events = t.fail(message);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message: string }).message).toHaveLength(4096);
    expect(t.fail('again')).toEqual([]);
  });
});
