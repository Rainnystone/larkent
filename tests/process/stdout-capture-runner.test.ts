import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as spawn from '../../src/platform/spawn.js';
import { runJsonlCli, wrapParsedTranslator } from '../../src/agent/runner/jsonl-cli-runner.js';
import { STDOUT_CAPTURE_ENV } from '../../src/agent/runner/stdout-capture.js';
import type { AgentEvent } from '../../src/agent/types.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('jsonl runner opt-in stdout capture', () => {
  it('persists redacted stdout before translation and strips the capture dir from the child env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stdout-cap-runner-'));
    dirs.push(dir);
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const { child, exit, start } = fixture({
      stdoutCaptureDir: dir,
      env: { [STDOUT_CAPTURE_ENV]: dir, PATH: '/usr/bin' },
      onSpawnEnv: (env) => { spawnedEnv = env; },
    });
    const run = start();
    child.stdout.write(`${JSON.stringify({
      event: 'step_update',
      prompt: 'hidden-prompt',
      step_update: {
        step_type: 'tool',
        state: 'ACTIVE',
        step_index: 1,
        tool_info: { parameters: { token: 'sk-runner-secret' } },
      },
    })}\n`);
    exit();
    await collect(run.events);
    expect(spawnedEnv?.[STDOUT_CAPTURE_ENV]).toBeUndefined();
    const files = await readCapture(dir);
    expect(files.body).not.toContain('sk-runner-secret');
    expect(files.body).not.toContain('hidden-prompt');
    expect(files.body).toContain('"step_type":"tool"');
    if (process.platform !== 'win32') {
      expect((await stat(files.path)).mode & 0o777).toBe(0o600);
    }
  });

  it('does not capture when the opt-in directory is unset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stdout-cap-off-'));
    dirs.push(dir);
    const { child, exit, start } = fixture({ env: { PATH: '/usr/bin' } });
    const run = start();
    child.stdout.write('{"event":"init"}\n');
    exit();
    await collect(run.events);
    const names = await listJsonl(dir);
    expect(names).toEqual([]);
  });
});

function fixture(options: {
  stdoutCaptureDir?: string;
  env?: NodeJS.ProcessEnv;
  onSpawnEnv?: (env: NodeJS.ProcessEnv) => void;
}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 42 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((_signal: NodeJS.Signals = 'SIGTERM') => true),
  });
  const exit = (): void => {
    child.exitCode = 0;
    child.signalCode = null;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
  };
  vi.spyOn(spawn, 'spawnProcess').mockImplementation((_cmd, _args, spawnOpts) => {
    options.onSpawnEnv?.(spawnOpts?.env ?? {});
    return child as never;
  });
  const start = () => runJsonlCli({
    runId: 'capture-run',
    binaryPath: '/fake',
    argv: [],
    cwd: '/tmp',
    env: options.env ?? {},
    spawnName: 'agy',
    stopGraceMs: 10,
    translator: wrapParsedTranslator({ translate: () => [{ type: 'liveness' }] }, 'agy'),
    ...(options.stdoutCaptureDir ? { stdoutCaptureDir: options.stdoutCaptureDir } : {}),
  });
  return { child, exit, start };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function readCapture(dir: string): Promise<{ path: string; body: string }> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  expect(names.length).toBe(1);
  const path = join(dir, names[0]!);
  return { path, body: await readFile(path, 'utf8') };
}

async function listJsonl(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
}
