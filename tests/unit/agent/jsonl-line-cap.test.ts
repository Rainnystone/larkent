import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({ spawnProcess: vi.fn() }));
vi.mock('../../../src/platform/spawn', () => ({ spawnProcess: spawnMock.spawnProcess }));

import { runJsonlCli, wrapParsedTranslator } from '../../../src/agent/runner/jsonl-cli-runner';

describe('jsonl line cap', () => {
  afterEach(() => {
    spawnMock.spawnProcess.mockReset();
  });

  it('fails the run when one line exceeds the cap and does not keep the line', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
        child.signalCode = signal;
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', null, signal);
        return true;
      }),
    });
    spawnMock.spawnProcess.mockReturnValue(child);
    const payload = 'y'.repeat(80);
    const run = runJsonlCli({
      runId: 'cap',
      binaryPath: '/fake',
      argv: [],
      cwd: '/tmp',
      env: {},
      spawnName: 'grok',
      stopGraceMs: 20,
      maxLineBytes: 32,
      translator: wrapParsedTranslator({
        translate: () => [],
        fail: (message: string) => [{ type: 'error', message, terminationReason: 'failed' as const }],
      }, 'grok'),
    });
    const collecting = (async () => {
      const events = [];
      for await (const event of run.events) events.push(event);
      return events;
    })();
    child.stdout.write(payload);
    const events = await collecting;
    const rendered = JSON.stringify(events);
    expect(rendered).toContain('exceeded');
    expect(rendered).not.toContain(payload);
    await run.stop().catch(() => {});
  });
});
