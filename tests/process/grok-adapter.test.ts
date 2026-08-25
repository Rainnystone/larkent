import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GrokAdapter } from '../../src/agent/grok/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const END = { type: 'end', stopReason: 'end_turn', sessionId: SESSION };

describe('GrokAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh print-mode run with rules, not a prefixed argv prompt', async () => {
    const fake = await createFakeGrok({
      lines: [{ type: 'text', data: 'OK' }, END],
    });
    cleanup.push(fake.dir);

    const run = new GrokAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      prompt: 'hello',
      cwd: fake.dir,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: SESSION },
      { type: 'final_text', content: 'OK' },
      { type: 'done', sessionId: SESSION, terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    expect(record.env.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(record.argv[0]).toBe('-p');
    expect(record.argv[1]).toBe('hello');
    expect(record.argv.slice(2, 4)).toEqual(['--output-format', 'streaming-json']);
    const rules = record.argv[record.argv.indexOf('--rules') + 1];
    expect(rules).toContain('lark-channel-bridge 运行约定');
    expect(record.argv).toContain('--always-approve');
    expect(record.argv).toContain('--no-auto-update');
    expect(record.argv).not.toContain('-r');
    expect(record.argv).not.toContain('-s');
    expect(record.argv).not.toContain('-m');
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeGrok({ lines: [END] });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'grok-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(
      rootDir,
      'profiles',
      'grok-dev',
      'lark-cli-source',
      'config.json',
    );

    const run = new GrokAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'grok-dev',
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
      LARK_CHANNEL_PROFILE: 'grok-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
      GROK_DISABLE_AUTOUPDATER: '1',
    });
  });

  it('passes -r and -m for resumed runs with a model override', async () => {
    const fake = await createFakeGrok({
      lines: [{ type: 'text', data: 'continued' }, END],
    });
    cleanup.push(fake.dir);

    const run = new GrokAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: SESSION,
      model: 'grok-build',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual(['-r', SESSION, '-m', 'grok-build']);
    expect(record.argv).not.toContain('-s');
  });

  it('maps tool call lines to tool_use/tool_result events', async () => {
    const fake = await createFakeGrok({
      lines: [
        {
          type: 'tool_call',
          toolCallId: 'call_1',
          toolName: 'run_terminal_cmd',
          status: 'in_progress',
          rawInput: { command: 'echo hi' },
        },
        {
          type: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'completed',
          rawOutput: { stdout: 'hi\n' },
        },
        { type: 'text', data: 'done' },
        END,
      ],
    });
    cleanup.push(fake.dir);

    const run = new GrokAdapter({ binary: fake.path }).run({
      runId: 'run-tools',
      prompt: 'hi',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'run_terminal_cmd',
        input: { command: 'echo hi' },
      },
      { type: 'tool_result', id: 'call_1', output: '{"stdout":"hi\\n"}', isError: false },
      { type: 'system', sessionId: SESSION },
      { type: 'final_text', content: 'done' },
      { type: 'done', sessionId: SESSION, terminationReason: 'normal' },
    ]);
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeGrok({
      lines: [{ type: 'text', data: 'before failure' }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new GrokAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure\n\n' },
      {
        type: 'error',
        message: 'grok exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    const missing = join(tmpdir(), `missing-grok-${Date.now()}`);
    const run = new GrokAdapter({ binary: missing }).run({
      runId: 'run-missing',
      prompt: 'hi',
      cwd: tmpdir(),
    });

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn grok|spawn returned no pid|grok exited with code/,
    );
  });

  it('stop() interrupts a hung run and reports done(interrupted)', async () => {
    const fake = await createFakeGrok({ lines: [], hang: true });
    cleanup.push(fake.dir);

    const run = new GrokAdapter({ binary: fake.path, stopGraceMs: 50 }).run({
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
      new GrokAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeGrok(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
  hang?: boolean;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'grok-adapter-test-'));
  const path = join(dir, 'fake-grok.mjs');
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
      '    GROK_DISABLE_AUTOUPDATER: process.env.GROK_DISABLE_AUTOUPDATER,',
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
    GROK_DISABLE_AUTOUPDATER?: string;
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
      GROK_DISABLE_AUTOUPDATER?: string;
    };
  };
}
