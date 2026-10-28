import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({ spawnProcess: vi.fn() }));
vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import { runJsonlCli, wrapParsedTranslator } from '../../../src/agent/runner/jsonl-cli-runner';

describe('terminal text cleanup', () => {
  it('turns CR progress and BEL into plain tool output and strips ANSI from final text', () => {
    const translator = new GrokJsonlTranslator();
    const events = [
      ...translator.translate({
        type: 'tool_call',
        toolCallId: 'call_1',
        toolName: 'run_terminal_command',
        status: 'in_progress',
        rawInput: { command: 'prog' },
      }),
      ...translator.translate({
        type: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed',
        rawOutput: { output: [...Buffer.from('prog\rDONE\u0007')] },
      }),
      ...translator.translate({ type: 'text', data: '\u001b[31mRED\u001b[0m' }),
      ...translator.finish('interrupted'),
    ];
    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({ type: 'tool_result', output: 'DONE' });
    const final = events.find((event) => event.type === 'text' && event.heldBack);
    expect(final).toEqual({ type: 'text', delta: 'RED', heldBack: true });
    expect(JSON.stringify(events)).not.toContain('\\u001b');
    expect(JSON.stringify(events)).not.toContain('\\u0007');
  });

  it('strips ANSI and BEL from the stderr snippet on a failed exit', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    });
    spawnMock.spawnProcess.mockReturnValue(child);
    const run = runJsonlCli({
      runId: 'stderr',
      binaryPath: '/fake',
      argv: [],
      cwd: '/tmp',
      env: {},
      spawnName: 'grok',
      stopGraceMs: 20,
      translator: wrapParsedTranslator(new GrokJsonlTranslator(), 'grok'),
    });
    child.stderr.write('boom \u001b[31mRED\u001b[0m\u0007\n');
    child.stderr.end();
    child.stdout.end();
    child.exitCode = 1;
    child.emit('exit', 1, null);
    const events = [];
    for await (const event of run.events) events.push(event);
    const error = events.find((event) => event.type === 'error');
    expect(error?.type).toBe('error');
    if (error?.type !== 'error') return;
    expect(error.message).toContain('RED');
    expect(error.message).not.toContain('\u001b');
    expect(error.message).not.toContain('\u0007');
    expect(error.message).not.toContain('\\u001b');
  });
});
