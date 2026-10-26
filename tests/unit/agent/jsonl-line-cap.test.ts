import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({ spawnProcess: vi.fn() }));
vi.mock('../../../src/platform/spawn', () => ({ spawnProcess: spawnMock.spawnProcess }));

import { runJsonlCli, wrapParsedTranslator } from '../../../src/agent/runner/jsonl-cli-runner';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import type { AgentEvent } from '../../../src/agent/types';

describe('jsonl line cap', () => {
  afterEach(() => {
    spawnMock.spawnProcess.mockReset();
  });

  it('rejects a complete Chinese JSONL line one byte above the default cap', async () => {
    // 25 JSON envelope bytes + 2,796,194 three-byte characters + two ASCII bytes.
    const line = `{"type":"text","data":"${'中'.repeat(2_796_194)}xx"}`;
    expect(Buffer.byteLength(line)).toBe(8_388_609);
    expect(line.length).toBeLessThan(8_388_608);
    const events = await runChunks([Buffer.from(`${line}\n`)]);
    expect(events.map(event => event.type)).toEqual(['error']);
    expect(events[0]).toMatchObject({
      message: 'grok runtime error: grok streaming-json line exceeded 8388608 bytes',
      terminationReason: 'failed',
    });
  });

  describe.each([
    ['ASCII below', 'x', 8_388_582, '', 8_388_607],
    ['ASCII exactly at', 'x', 8_388_583, '', 8_388_608],
    ['Chinese below', '中', 2_796_194, '', 8_388_607],
    ['Chinese exactly at', '中', 2_796_194, 'x', 8_388_608],
  ] as const)('%s the default byte cap', (_label, char, count, suffix, bytes) => {
    it.each(['LF in same chunk', 'LF in next chunk', 'EOF', 'split UTF-8'] as const)('accepts %s', async framing => {
      const content = char.repeat(count) + suffix;
      const line = Buffer.from(`{"type":"text","data":"${content}"}`);
      expect(line.length).toBe(bytes);
      let chunks: Buffer[];
      switch (framing) {
        case 'LF in same chunk': chunks = [Buffer.concat([line, Buffer.from('\n')])]; break;
        case 'LF in next chunk': chunks = [line, Buffer.from('\n')]; break;
        case 'EOF': chunks = [line]; break;
        case 'split UTF-8':
          // Byte 23 is inside the first Chinese character.
          chunks = [line.subarray(0, 23), line.subarray(23, line.length - 3), line.subarray(line.length - 3), Buffer.from('\n')];
          break;
      }
      const events = await runChunks(chunks);
      expect(events.map(event => event.type)).toEqual(['system', 'final_text', 'done']);
      expect(events[1]).toEqual({ type: 'final_text', content });
      expect(events[2]).toMatchObject({ terminationReason: 'normal' });
    });
  });

  it.each([
    ['ASCII', 'x', 8_388_584, '', 8_388_609],
    ['Chinese', '中', 2_796_194, 'xx', 8_388_609],
    ['pure Chinese', '中', 2_796_195, '', 8_388_610],
  ] as const)('rejects oversized %s with and without LF', async (_label, char, count, suffix, bytes) => {
    const content = char.repeat(count) + suffix;
    const line = Buffer.from(`{"type":"text","data":"${content}"}`);
    expect(line.length).toBe(bytes);
    for (const chunks of [
      [Buffer.concat([line, Buffer.from('\n')])],
      [line],
      [line.subarray(0, line.length - 4), Buffer.concat([line.subarray(line.length - 4), Buffer.from('\n')])],
      [line, Buffer.from('\n')],
    ]) {
      const events = await runChunks(chunks);
      expect(events.map(event => event.type)).toEqual(['error']);
      expect(events[0]).toMatchObject({ terminationReason: 'failed' });
      expect(JSON.stringify(events)).toContain('exceeded 8388608 bytes');
    }
  });

  it('counts CR and whitespace before trimming, excluding only the LF delimiter', async () => {
    const line = `{"type":"text","data":"${'中'.repeat(2_796_194)}"}`;
    const accepted = await runChunks([Buffer.from(`${line}\r\n`)]);
    expect(accepted.map(event => event.type)).toEqual(['system', 'final_text', 'done']);
    const rejected = await runChunks([Buffer.from(`${line} \r\n`)]);
    expect(rejected.map(event => event.type)).toEqual(['error']);
    expect(JSON.stringify(rejected)).toContain('exceeded 8388608 bytes');
  });

  it('applies the cap per line when several valid records share a chunk', async () => {
    const line = `{"type":"text","data":"${'中'.repeat(1_398_097)}"}\n`;
    const events = await runChunks([Buffer.from(line.repeat(2))]);
    expect(events.map(event => event.type)).toEqual(['system', 'system', 'final_text', 'done']);
    expect(events[2]).toEqual({ type: 'final_text', content: '中'.repeat(2_796_194) });
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

async function runChunks(chunks: Buffer[]): Promise<AgentEvent[]> {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
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
  const run = runJsonlCli({
    runId: 'utf8-cap', binaryPath: '/fake', argv: [], cwd: '/tmp', env: {},
    spawnName: 'grok', stopGraceMs: 20,
    successFinish: 'normal',
    translator: wrapParsedTranslator(new GrokJsonlTranslator(), 'grok'),
  });
  const collecting = (async () => {
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    return events;
  })();
  try {
    for (const chunk of chunks) child.stdout.write(chunk);
    if (child.signalCode === null) {
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', 0, null);
    }
    return await collecting;
  } finally {
    await run.stop();
  }
}
