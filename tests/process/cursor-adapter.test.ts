import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CursorAdapter } from '../../src/agent/cursor/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

const SESSION = 'c6b62c6f-7ead-4fd6-9922-e952131177ff';
const INIT = {
  type: 'system',
  subtype: 'init',
  cwd: '/tmp',
  session_id: SESSION,
  model: 'Composer 2.5',
};
const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ignored-concat',
  session_id: SESSION,
};

describe('CursorAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh print-mode run with the bridge prompt as the last argv', async () => {
    const fake = await createFakeCursor({
      lines: [
        INIT,
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
        },
        RESULT,
      ],
    });
    cleanup.push(fake.dir);

    const run = new CursorAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      prompt: 'hello',
      cwd: fake.dir,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: SESSION, cwd: '/tmp', model: 'Composer 2.5' },
      { type: 'final_text', content: 'OK' },
      { type: 'done', sessionId: SESSION, terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    expect(record.argv[0]).toBe('-p');
    expect(record.argv.slice(1, 8)).toEqual([
      '--output-format',
      'stream-json',
      '--force',
      '--sandbox',
      'disabled',
      '--approve-mcps',
      '--trust',
    ]);
    expect(record.argv.at(-1)).toContain('lark-channel-bridge 运行约定');
    expect(record.argv.at(-1)).toContain('## user_message\n\nhello');
    expect(record.argv).not.toContain('--resume');
    expect(record.argv).not.toContain('--model');
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeCursor({ lines: [INIT, RESULT] });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'cursor-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(
      rootDir,
      'profiles',
      'cursor-dev',
      'lark-cli-source',
      'config.json',
    );

    const run = new CursorAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'cursor-dev',
        rootDir,
        configPath,
        larkCliConfigDir,
        larkCliSourceConfigFile,
      },
    }).run({
      runId: 'run-profile-env',
      prompt: 'profile',
      cwd: fake.dir,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'cursor-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
  });

  it('passes --resume and --model for resumed runs', async () => {
    const fake = await createFakeCursor({
      lines: [
        INIT,
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'continued' }] },
        },
        RESULT,
      ],
    });
    cleanup.push(fake.dir);

    const run = new CursorAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'session_old',
      model: 'composer-2.5',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.argv).toContain('--resume');
    expect(record.argv[record.argv.indexOf('--resume') + 1]).toBe('session_old');
    expect(record.argv).toContain('--model');
    expect(record.argv[record.argv.indexOf('--model') + 1]).toBe('composer-2.5');
    expect(record.argv.at(-1)).toContain('## user_message\n\ncontinue');
  });

  it('includes stderr when the process exits non-zero without a result line', async () => {
    const fake = await createFakeCursor({
      lines: [
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'before failure' }] },
        },
      ],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new CursorAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure\n\n' },
      {
        type: 'error',
        message: 'cursor exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    const missing = join(tmpdir(), `missing-cursor-${Date.now()}`);
    const run = new CursorAdapter({ binary: missing }).run({
      runId: 'run-missing',
      prompt: 'hi',
      cwd: tmpdir(),
    });

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn cursor|spawn returned no pid|cursor exited with code/,
    );
  });

  it('stop() interrupts a hung run and reports done(interrupted)', async () => {
    const fake = await createFakeCursor({ lines: [], hang: true });
    cleanup.push(fake.dir);

    const run = new CursorAdapter({ binary: fake.path, stopGraceMs: 50 }).run({
      runId: 'run-hang',
      prompt: 'hang',
      cwd: fake.dir,
    });
    const iterator = run.events[Symbol.asyncIterator]();

    await run.stop();
    const events: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(events).toEqual([{ type: 'done', terminationReason: 'interrupted' }]);
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new CursorAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeCursor(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
  hang?: boolean;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-adapter-test-'));
  const path = join(dir, 'fake-cursor.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '  argv,',
      '  cwd: process.cwd(),',
      '  env: {',
      '    LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '    LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '    LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '    LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '    LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '  },',
      '}));',
      `const lines = ${JSON.stringify(options.lines)};`,
      'for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      options.hang
        ? 'setInterval(() => {}, 1000);'
        : `setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
    ]
      .filter(Boolean)
      .join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  cwd: string;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    LARK_CHANNEL_HOME?: string;
    LARK_CHANNEL_CONFIG?: string;
    LARKSUITE_CLI_CONFIG_DIR?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    cwd: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
    };
  };
}
