import { getEventListeners } from 'node:events';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import { buildCodexArgs } from '../../src/agent/codex/argv.js';
import { CursorAdapter } from '../../src/agent/cursor/adapter.js';
import { GrokAdapter } from '../../src/agent/grok/adapter.js';
import { KimiAdapter } from '../../src/agent/kimi/adapter.js';
import { runJsonlCli, wrapParsedTranslator } from '../../src/agent/runner/jsonl-cli-runner.js';
import type { AgentEvent } from '../../src/agent/types.js';

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('wrapParsedTranslator', () => {
  it('skips invalid JSON and lets translator exceptions propagate', () => {
    const translator = wrapParsedTranslator(
      {
        translate(parsed: unknown) {
          const row = parsed as { boom?: boolean };
          if (row.boom) throw new Error('translator-boom');
          return [{ type: 'text', delta: 'ok' }];
        },
      },
      'wrap',
    );
    expect(translator.translate('not-json')).toEqual([]);
    expect(translator.translate('{"ok":true}')).toEqual([{ type: 'text', delta: 'ok' }]);
    expect(() => translator.translate('{"boom":true}')).toThrow(/translator-boom/);
  });
});

describe('runJsonlCli', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('translates two JSONL dialects through one runner', async () => {
    const cases = [
      {
        name: 'claude-like',
        lines: [{ type: 'result', session_id: 's1' }],
        events: [{ type: 'done', sessionId: 's1', terminationReason: 'normal' }],
        translate: (parsed: unknown) => {
          const row = parsed as { type?: string; session_id?: string };
          if (row.type === 'result') {
            return [{ type: 'done' as const, sessionId: row.session_id, terminationReason: 'normal' as const }];
          }
          return [];
        },
      },
      {
        name: 'kimi-like',
        lines: [{ role: 'assistant', content: 'hi' }],
        events: [
          { type: 'text', delta: 'hi' },
          { type: 'done', terminationReason: 'normal' },
        ],
        translate: (parsed: unknown) => {
          const row = parsed as { role?: string; content?: string };
          return row.role === 'assistant' && row.content
            ? [{ type: 'text' as const, delta: row.content }]
            : [];
        },
        finish: () => [{ type: 'done' as const, terminationReason: 'normal' as const }],
      },
    ];

    for (const fixture of cases) {
      const fake = await createFakeClaude({ lines: fixture.lines });
      cleanup.push(fake.dir);
      const run = runJsonlCli({
        runId: `run-${fixture.name}`,
        binaryPath: fake.path,
        argv: [],
        cwd: fake.dir,
        env: process.env,
        translator: wrapParsedTranslator(
          {
            translate: fixture.translate,
            ...(fixture.finish ? { finish: fixture.finish } : {}),
          },
          fixture.name,
        ),
        spawnName: fixture.name,
        successFinish: 'normal',
      });
      expect(await collect(run.events)).toEqual(fixture.events);
    }
  });

  it('emits a timeout error on idle and does not leak the child', async () => {
    const fake = await createFakeClaude({ lines: [], hang: true });
    cleanup.push(fake.dir);
    const run = runJsonlCli({
      runId: 'run-idle',
      binaryPath: fake.path,
      argv: [],
      cwd: fake.dir,
      env: process.env,
      translator: wrapParsedTranslator({ translate: () => [] }, 'idle'),
      spawnName: 'idle',
      timeouts: { idleMs: 80 },
      stopGraceMs: 50,
    });
    const events = await collect(run.events);
    expect(events).toEqual([
      { type: 'error', message: 'idle timeout', terminationReason: 'timeout' },
    ]);
    expect(await run.waitForExit(1_000)).toBe(true);
  });

  it('aborts a hung child through AbortSignal', async () => {
    const fake = await createFakeClaude({ lines: [], hang: true });
    cleanup.push(fake.dir);
    const controller = new AbortController();
    const run = runJsonlCli({
      runId: 'run-abort',
      binaryPath: fake.path,
      argv: [],
      cwd: fake.dir,
      env: process.env,
      translator: wrapParsedTranslator(
        {
          translate: () => [],
          finish: (reason) => [
            { type: 'done' as const, terminationReason: reason === 'interrupted' ? 'interrupted' : 'normal' },
          ],
        },
        'abort',
      ),
      spawnName: 'abort',
      signal: controller.signal,
      stopGraceMs: 50,
    });
    const pending = collect(run.events);
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    expect(await pending).toEqual([{ type: 'done', terminationReason: 'interrupted' }]);
    expect(await run.waitForExit(1_000)).toBe(true);
  });

  it('decodes JSONL stdout when a chunk splits a multibyte UTF-8 character', async () => {
    const fake = await createFakeRunnerBinary(`
import { setTimeout as delay } from 'node:timers/promises';
const payload = JSON.stringify({ type: 'assistant', text: '你好世界' }) + '\\n';
const buf = Buffer.from(payload, 'utf8');
const splitAt = buf.indexOf(Buffer.from('你', 'utf8')) + 1;
process.stdout.write(buf.subarray(0, splitAt));
await delay(20);
process.stdout.write(buf.subarray(splitAt));
process.exit(0);
`);
    cleanup.push(fake.dir);
    const run = runJsonlCli({
      runId: 'run-utf8',
      binaryPath: fake.path,
      argv: [],
      cwd: fake.dir,
      env: process.env,
      translator: wrapParsedTranslator(
        {
          translate: (parsed) => {
            const row = parsed as { type?: string; text?: string };
            return row.type === 'assistant' && row.text
              ? [{ type: 'text' as const, delta: row.text }]
              : [];
          },
          finish: () => [{ type: 'done' as const, terminationReason: 'normal' as const }],
        },
        'utf8',
      ),
      spawnName: 'utf8',
      successFinish: 'normal',
    });
    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: '你好世界' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('resets idle timeout when a complete stdout line is enqueued', async () => {
    const fake = await createFakeRunnerBinary(`
import { setTimeout as delay } from 'node:timers/promises';
for (const n of [1, 2, 3, 4, 5, 6]) {
  console.log(JSON.stringify({ n }));
  await delay(40);
}
process.exit(0);
`);
    cleanup.push(fake.dir);
    const run = runJsonlCli({
      runId: 'run-idle-enqueue',
      binaryPath: fake.path,
      argv: [],
      cwd: fake.dir,
      env: process.env,
      translator: wrapParsedTranslator(
        {
          translate: (parsed) => [{ type: 'text' as const, delta: String((parsed as { n: number }).n) }],
          finish: () => [{ type: 'done' as const, terminationReason: 'normal' as const }],
        },
        'idle-enqueue',
      ),
      spawnName: 'idle-enqueue',
      timeouts: { idleMs: 70 },
      stopGraceMs: 50,
      successFinish: 'normal',
    });
    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    expect(events).toEqual([
      { type: 'text', delta: '1' },
      { type: 'text', delta: '2' },
      { type: 'text', delta: '3' },
      { type: 'text', delta: '4' },
      { type: 'text', delta: '5' },
      { type: 'text', delta: '6' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('awaits the same in-flight cleanup from exit and generator finally', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 's-clean' }],
    });
    cleanup.push(fake.dir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let finished = 0;
    const run = runJsonlCli({
      runId: 'run-shared-cleanup',
      binaryPath: fake.path,
      argv: [],
      cwd: fake.dir,
      env: process.env,
      translator: wrapParsedTranslator(
        {
          translate: (parsed) => {
            const row = parsed as { type?: string; session_id?: string };
            return row.type === 'result'
              ? [{ type: 'done' as const, sessionId: row.session_id, terminationReason: 'normal' as const }]
              : [];
          },
        },
        'shared-cleanup',
      ),
      cleanup: async () => {
        started += 1;
        await gate;
        finished += 1;
      },
      spawnName: 'shared-cleanup',
    });
    const pending = collect(run.events);
    let collectDone = false;
    void pending.then(() => {
      collectDone = true;
    });
    const deadline = Date.now() + 2_000;
    while (started === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(started).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(collectDone).toBe(false);
    expect(finished).toBe(0);
    release();
    expect(await pending).toEqual([
      { type: 'done', sessionId: 's-clean', terminationReason: 'normal' },
    ]);
    expect(started).toBe(1);
    expect(finished).toBe(1);
  });

  it('does not run adapter cleanup until the child has exited', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-tail' }],
      exitDelayMs: 150,
    });
    cleanup.push(fake.dir);
    let cleaned = false;
    const run = runJsonlCli({
      runId: 'run-cleanup-after-exit',
      binaryPath: fake.path,
      argv: [],
      cwd: fake.dir,
      env: process.env,
      translator: wrapParsedTranslator(
        {
          translate: (parsed) => {
            const row = parsed as { type?: string; session_id?: string };
            return row.type === 'result'
              ? [{ type: 'done' as const, sessionId: row.session_id, terminationReason: 'normal' as const }]
              : [];
          },
        },
        'cleanup-after-exit',
      ),
      cleanup: () => {
        cleaned = true;
      },
      spawnName: 'cleanup-after-exit',
    });
    const iterator = run.events[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-tail', terminationReason: 'normal' },
    });
    expect(cleaned).toBe(false);
    expect(await run.waitForExit(10)).toBe(false);
    expect(cleaned).toBe(false);
    expect(await run.waitForExit(1_000)).toBe(true);
    await iterator.return?.();
    expect(cleaned).toBe(true);
  });

  it('removes abort listeners after a completed run', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 's-abort-detach' }],
    });
    cleanup.push(fake.dir);
    const controller = new AbortController();
    const run = runJsonlCli({
      runId: 'run-abort-detach',
      binaryPath: fake.path,
      argv: [],
      cwd: fake.dir,
      env: process.env,
      translator: wrapParsedTranslator(
        {
          translate: (parsed) => {
            const row = parsed as { type?: string; session_id?: string };
            return row.type === 'result'
              ? [{ type: 'done' as const, sessionId: row.session_id, terminationReason: 'normal' as const }]
              : [];
          },
        },
        'abort-detach',
      ),
      spawnName: 'abort-detach',
      signal: controller.signal,
    });
    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 's-abort-detach', terminationReason: 'normal' },
    ]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    expect(() => controller.abort()).not.toThrow();
  });
});

async function createFakeRunnerBinary(body: string): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-runner-test-'));
  const path = join(dir, 'fake-cli.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}


interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('ClaudeAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh run with stream-json, verbose, permission mode, and bridge prompt args', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-fresh' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      prompt: 'hello',
      cwd: fake.dir,
      permissionMode: 'acceptEdits',
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);
    const record = await readClaudeRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    // The prompt goes via stdin, and the bridge system prompt via a temp file,
    // so neither ever touches argv (which cmd.exe would mangle on Windows).
    expect(record.stdin).toBe('hello');
    expect(record.argv.slice(0, 7)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--append-system-prompt-file',
    ]);
    expect(record.argv).not.toContain('hello');
    expect(record.systemPrompt).toContain('lark-channel-bridge 运行约定');
    expect(record.systemPrompt).toContain('__bridge_cb');
    expect(record.systemPrompt).toContain('LARK_CHANNEL_PROFILE');
    expect(record.systemPrompt).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(record.systemPrompt).not.toContain('lark-cli config bind --source lark-channel');
    expect(record.systemPrompt).not.toContain('__claude_cb');
    expect(record.argv).not.toContain('--resume');
    expect(record.argv).not.toContain('--model');
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-profile' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'codex-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'codex-dev', 'lark-cli-source', 'config.json');

    const run = new ClaudeAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'codex-dev',
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
    const record = await readClaudeRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
  });

  it('passes resume and model after the base CLI contract', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-resumed' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'sess-old',
      model: 'sonnet',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' },
    ]);
    const record = await readClaudeRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual(['--resume', 'sess-old', '--model', 'sonnet']);
    expect(record.argv[5]).toBe('bypassPermissions');
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'before failure' }] } }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'claude exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<ClaudeAdapter['run']>;
    if (process.platform === 'win32') {
      const fake = await createFakeClaude({
        lines: [],
        stderr: 'missing command\n',
        exitCode: 1,
      });
      cleanup.push(fake.dir);
      run = new ClaudeAdapter({ binary: fake.path }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: fake.dir,
      });
    } else {
      const missing = join(tmpdir(), `missing-claude-${Date.now()}`);
      run = new ClaudeAdapter({ binary: missing }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn claude|spawn returned no pid|claude exited with code/,
    );
  });

  it('waits for post-done process exit before stop fallback is needed', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-tail' }],
      exitDelayMs: 150,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-tail',
      prompt: 'tail',
      cwd: fake.dir,
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-tail', terminationReason: 'normal' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    expect(await run.waitForExit(1_000)).toBe(true);
    await iterator.return?.();
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new ClaudeAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

async function createFakeClaude(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
  hang?: boolean;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-adapter-test-'));
  const path = join(dir, 'fake-claude.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync, readFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'const spIdx = argv.indexOf("--append-system-prompt-file");',
      'const systemPrompt = spIdx !== -1 ? readFileSync(argv[spIdx + 1], "utf8") : null;',
      'let stdin = "";',
      'process.stdin.on("data", (c) => { stdin += c; });',
      'process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv,',
      '    stdin,',
      '    systemPrompt,',
      '    cwd: process.cwd(),',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      options.hang
        ? '  setInterval(() => {}, 1000);'
        : `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '});',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readClaudeRecord(path: string): Promise<{
  argv: string[];
  stdin: string;
  systemPrompt: string | null;
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
    stdin: string;
    systemPrompt: string | null;
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

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('CodexAdapter process contract', () => {
  const cleanup: string[] = [];
  const oldCodexHome = process.env.CODEX_HOME;
  const oldAppSecret = process.env.APP_SECRET;

  afterEach(async () => {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    if (oldAppSecret === undefined) {
      delete process.env.APP_SECRET;
    } else {
      process.env.APP_SECRET = oldAppSecret;
    }
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh JSON run with prompt on stdin and inherits the user Codex home by default', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    process.env.APP_SECRET = 'inherited-secret';
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-fresh' },
        { type: 'agent_message', message: 'hello user' },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
    }).run({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-fresh' },
      { type: 'final_text', content: 'hello user' },
      { type: 'done', threadId: 'thread-fresh', terminationReason: 'normal' },
    ]);
    const record = await readCodexRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(buildCodexArgs({ cwd, sandbox: 'read-only' }));
    expect(record.argv).not.toContain('--ignore-user-config');
    expect(record.argv).toContain('--skip-git-repo-check');
    expect(record.argv).not.toContain('hello from lark');
    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('__bridge_cb');
    expect(record.stdin).toContain('lark-cli auth login');
    expect(record.stdin).toContain('LARK_CHANNEL_PROFILE');
    expect(record.stdin).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(record.stdin).not.toContain('lark-cli config bind --source lark-channel');
    expect(record.stdin).toContain('hello from lark');
    expect(record.stdin).not.toBe('hello from lark');
    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      CODEX_HOME: '/outer/codex-home',
    });
    expect(record.env.APP_SECRET).toBe('inherited-secret');
  });

  it('injects the active bridge profile env while preserving Codex env overrides', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'codex-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'codex-dev', 'lark-cli-source', 'config.json');

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      larkChannel: {
        profile: 'codex-dev',
        rootDir,
        configPath,
        larkCliConfigDir,
        larkCliSourceConfigFile,
      },
    }).run({
      runId: 'run-profile-env',
      prompt: 'profile',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readCodexRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
      CODEX_HOME: '/outer/codex-home',
    });
  });

  it('leaves CODEX_HOME unset by default so Codex can use the user login under ~/.codex', async () => {
    delete process.env.CODEX_HOME;
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    }).run({
      runId: 'run-default-home',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readCodexRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBeUndefined();
  });

  it('passes image paths and resume thread through the Codex argv contract', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(fake.dir, 'image.png');

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'workspace-write',
    }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      threadId: 'thread-old',
      images: [image],
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
    const record = await readCodexRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildCodexArgs({
        cwd,
        sandbox: 'workspace-write',
        threadId: 'thread-old',
        images: [image],
      }),
    );
  });

  it('lets per-run policy sandbox override the adapter default', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'danger-full-access',
    }).run({
      runId: 'run-policy-sandbox',
      prompt: 'policy sandbox',
      cwd,
      sandbox: 'read-only',
    });

    await collect(run.events);
    const record = await readCodexRecord(fake.recordPath);
    expect(record.argv).toEqual(buildCodexArgs({ cwd, sandbox: 'read-only' }));
  });

  it('honors a profile-configured Codex home', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const codexHome = join(fake.dir, 'custom-codex-home');

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      codexHome,
    }).run({
      runId: 'run-home',
      prompt: 'home',
      cwd,
    });

    await collect(run.events);
    const record = await readCodexRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBe(codexHome);
  });

  it('uses a profile-local Codex home only when inheritance is explicitly disabled', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: false,
    }).run({
      runId: 'run-profile-local-home',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readCodexRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBe(join(fake.dir, 'codex-home'));
  });

  it('passes configured Codex ignore flags through the argv builder', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreUserConfig: false,
      ignoreRules: false,
    }).run({
      runId: 'run-flags',
      prompt: 'flags',
      cwd,
    });

    await collect(run.events);
    const record = await readCodexRecord(fake.recordPath);
    expect(record.argv).not.toContain('--ignore-user-config');
    expect(record.argv).not.toContain('--ignore-rules');
  });

  it('can explicitly isolate Codex from the user config', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreUserConfig: true,
    }).run({
      runId: 'run-ignore-user-config',
      prompt: 'flags',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readCodexRecord(fake.recordPath);
    expect(record.argv).toContain('--ignore-user-config');
  });

  it('includes stderr when the process exits non-zero before a terminal event', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'agent_message', message: 'before failure' }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'codex exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('continues after retryable raw error events and waits for the terminal turn event', async () => {
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-retry' },
        {
          type: 'error',
          error: { message: 'Reconnecting... 2/5 (timeout waiting for child process to exit)' },
        },
        { type: 'agent_message', message: 'after retry' },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-retry',
      prompt: 'retry',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-retry' },
      { type: 'final_text', content: 'after retry' },
      { type: 'done', threadId: 'thread-retry', terminationReason: 'normal' },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<CodexAdapter['run']>;
    if (process.platform === 'win32') {
      const fake = await createFakeCodex({
        lines: [],
        stderr: 'missing command\n',
        exitCode: 1,
      });
      cleanup.push(fake.dir);
      run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: await realpath(fake.dir),
      });
    } else {
      const missing = join(tmpdir(), `missing-codex-${Date.now()}`);
      run = new CodexAdapter({ binary: missing, profileStateDir: tmpdir() }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn codex|spawn returned no pid|codex exited with code/,
    );
  });

  it('reports interrupted termination when stopped before a Codex terminal event', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'thread.started', thread_id: 'thread-stop' }],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
    }).run({
      runId: 'run-stop',
      prompt: 'stop',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', threadId: 'thread-stop' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', threadId: 'thread-stop', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new CodexAdapter({ binary: 'unused', profileStateDir: tmpdir() }).run({
        runId: 'run-no-cwd',
        prompt: 'hi',
      }),
    ).toThrow(/cwd is required/);
  });
});

async function createFakeCodex(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-adapter-test-'));
  const path = join(dir, 'fake-codex.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { stdin += chunk; });',
      'process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv: process.argv.slice(2),',
      '    cwd: process.cwd(),',
      '    stdin,',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '      CODEX_HOME: process.env.CODEX_HOME,',
      '      APP_SECRET: process.env.APP_SECRET,',
      '      PATH: process.env.PATH,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '});',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readCodexRecord(path: string): Promise<{
  argv: string[];
  cwd: string;
  stdin: string;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    LARK_CHANNEL_HOME?: string;
    LARK_CHANNEL_CONFIG?: string;
    LARKSUITE_CLI_CONFIG_DIR?: string;
    CODEX_HOME?: string;
    APP_SECRET?: string;
    PATH?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    cwd: string;
    stdin: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
      CODEX_HOME?: string;
      APP_SECRET?: string;
      PATH?: string;
    };
  };
}

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

const RESUME_HINT = {
  role: 'meta',
  type: 'session.resume_hint',
  session_id: 'session_fake',
  command: 'kimi -r session_fake',
};

describe('KimiAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh print-mode run with the bridge prompt in argv', async () => {
    const fake = await createFakeKimi({
      lines: [{ role: 'assistant', content: 'OK' }, RESUME_HINT],
    });
    cleanup.push(fake.dir);

    const run = new KimiAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      prompt: 'hello',
      cwd: fake.dir,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'session_fake' },
      { type: 'final_text', content: 'OK' },
      { type: 'done', sessionId: 'session_fake', terminationReason: 'normal' },
    ]);
    const record = await readKimiRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    expect(record.argv[0]).toBe('-p');
    expect(record.argv.slice(2, 4)).toEqual(['--output-format', 'stream-json']);
    // kimi `-p` cannot read the prompt from stdin, so the prompt (prefixed
    // with the bridge system prompt) travels as a single argv element.
    expect(record.argv[1]).toContain('lark-channel-bridge 运行约定');
    expect(record.argv[1]).toContain('## user_message\n\nhello');
    expect(record.argv).not.toContain('-S');
    expect(record.argv).not.toContain('-m');
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeKimi({ lines: [RESUME_HINT] });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'kimi-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'kimi-dev', 'lark-cli-source', 'config.json');

    const run = new KimiAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'kimi-dev',
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
    const record = await readKimiRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'kimi-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
  });

  it('passes -S and -m for resumed runs with a model override', async () => {
    const fake = await createFakeKimi({
      lines: [{ role: 'assistant', content: 'continued' }, RESUME_HINT],
    });
    cleanup.push(fake.dir);

    const run = new KimiAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'session_old',
      model: 'kimi-code/kimi-for-coding',
    });

    await collect(run.events);
    const record = await readKimiRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual(['-S', 'session_old', '-m', 'kimi-code/kimi-for-coding']);
  });

  it('maps tool call lines to tool_use/tool_result events', async () => {
    const fake = await createFakeKimi({
      lines: [
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
        { role: 'assistant', content: 'done' },
        RESUME_HINT,
      ],
    });
    cleanup.push(fake.dir);

    const run = new KimiAdapter({ binary: fake.path }).run({
      runId: 'run-tools',
      prompt: 'hi',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'echo hi' } },
      { type: 'tool_result', id: 'tool_1', output: 'hi\n', isError: false },
      { type: 'system', sessionId: 'session_fake' },
      { type: 'final_text', content: 'done' },
      { type: 'done', sessionId: 'session_fake', terminationReason: 'normal' },
    ]);
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeKimi({
      lines: [{ role: 'assistant', content: 'before failure' }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new KimiAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure\n\n' },
      {
        type: 'error',
        message: 'kimi exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    const missing = join(tmpdir(), `missing-kimi-${Date.now()}`);
    const run = new KimiAdapter({ binary: missing }).run({
      runId: 'run-missing',
      prompt: 'hi',
      cwd: tmpdir(),
    });

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn kimi|spawn returned no pid|kimi exited with code/,
    );
  });

  it('stop() interrupts a hung run and reports done(interrupted)', async () => {
    const fake = await createFakeKimi({ lines: [], hang: true });
    cleanup.push(fake.dir);

    const run = new KimiAdapter({ binary: fake.path, stopGraceMs: 50 }).run({
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
      new KimiAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

async function createFakeKimi(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
  hang?: boolean;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-adapter-test-'));
  const path = join(dir, 'fake-kimi.mjs');
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

async function readKimiRecord(path: string): Promise<{
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

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

const GROK_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const END = { type: 'end', stopReason: 'end_turn', sessionId: GROK_SESSION };

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
      { type: 'system', sessionId: GROK_SESSION },
      { type: 'final_text', content: 'OK' },
      { type: 'done', sessionId: GROK_SESSION, terminationReason: 'normal' },
    ]);
    const record = await readGrokRecord(fake.recordPath);

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
    const record = await readGrokRecord(fake.recordPath);

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
      sessionId: GROK_SESSION,
      model: 'grok-build',
    });

    await collect(run.events);
    const record = await readGrokRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual(['-r', GROK_SESSION, '-m', 'grok-build']);
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
      { type: 'system', sessionId: GROK_SESSION },
      { type: 'final_text', content: 'done' },
      { type: 'done', sessionId: GROK_SESSION, terminationReason: 'normal' },
    ]);
  });

  it('fails when grok exits 0 without a streaming-json end event', async () => {
    const fake = await createFakeGrok({
      lines: [{ type: 'text', data: 'orphan' }],
    });
    cleanup.push(fake.dir);

    const run = new GrokAdapter({ binary: fake.path }).run({
      runId: 'run-no-end',
      prompt: 'hi',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'orphan\n\n' },
      {
        type: 'error',
        message: 'grok exited before a terminal streaming-json end event',
        terminationReason: 'failed',
      },
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

async function readGrokRecord(path: string): Promise<{
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

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

const CURSOR_SESSION = 'c6b62c6f-7ead-4fd6-9922-e952131177ff';
const INIT = {
  type: 'system',
  subtype: 'init',
  cwd: '/tmp',
  session_id: CURSOR_SESSION,
  model: 'Composer 2.5',
};
const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ignored-concat',
  session_id: CURSOR_SESSION,
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
      { type: 'system', sessionId: CURSOR_SESSION, cwd: '/tmp', model: 'Composer 2.5' },
      { type: 'final_text', content: 'OK' },
      { type: 'done', sessionId: CURSOR_SESSION, terminationReason: 'normal' },
    ]);
    const record = await readCursorRecord(fake.recordPath);

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
    const record = await readCursorRecord(fake.recordPath);

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
    const record = await readCursorRecord(fake.recordPath);

    expect(record.argv).toContain('--resume');
    expect(record.argv[record.argv.indexOf('--resume') + 1]).toBe('session_old');
    expect(record.argv).toContain('--model');
    expect(record.argv[record.argv.indexOf('--model') + 1]).toBe('composer-2.5');
    expect(record.argv.at(-1)).toContain('## user_message\n\ncontinue');
  });

  it('fails when cursor exits 0 without a result event', async () => {
    const fake = await createFakeCursor({
      lines: [
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'orphan' }] },
        },
      ],
    });
    cleanup.push(fake.dir);

    const run = new CursorAdapter({ binary: fake.path }).run({
      runId: 'run-no-result',
      prompt: 'hi',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'orphan\n\n' },
      {
        type: 'error',
        message: 'cursor stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
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

  it('refuses restricted sandbox before spawn', () => {
    expect(() =>
      new CursorAdapter({ binary: 'unused' }).run({
        runId: 'run-ro',
        prompt: 'hi',
        cwd: tmpdir(),
        sandbox: 'read-only',
      }),
    ).toThrow(/only supports full access/);
  });
});

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

async function readCursorRecord(path: string): Promise<{
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
