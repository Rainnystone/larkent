import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import { buildClaudeArgs } from '../../src/agent/claude/argv.js';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import { buildCodexArgs } from '../../src/agent/codex/argv.js';
import { CursorAdapter } from '../../src/agent/cursor/adapter.js';
import { GrokAdapter } from '../../src/agent/grok/adapter.js';
import { KimiAdapter } from '../../src/agent/kimi/adapter.js';
import {
  AGENT_KINDS,
  descriptorFor,
  type AgentKind,
} from '../../src/agent/registry.js';
import {
  JsonlRunAborted,
  parseJsonlLine,
  runJsonlCli,
  type JsonlTranslator,
} from '../../src/agent/runner/jsonl-cli-runner.js';
import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../../src/agent/types.js';
import type { LarkChannelEnvContext } from '../../src/agent/lark-channel-env.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

interface FakeRecord {
  argv: string[];
  cwd: string;
  stdin: string;
  systemPrompt: string | null;
  env: Record<string, string | undefined>;
}

const GROK_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CURSOR_SESSION = 'c6b62c6f-7ead-4fd6-9922-e952131177ff';
const KIMI_RESUME = {
  role: 'meta',
  type: 'session.resume_hint',
  session_id: 'session_fake',
  command: 'kimi -r session_fake',
};
const GROK_END = { type: 'end', stopReason: 'end_turn', sessionId: GROK_SESSION };
const CURSOR_INIT = {
  type: 'system',
  subtype: 'init',
  cwd: '/tmp',
  session_id: CURSOR_SESSION,
  model: 'Composer 2.5',
};
const CURSOR_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ignored-concat',
  session_id: CURSOR_SESSION,
};

const FRESH_LINES: Record<AgentKind, unknown[]> = {
  claude: [{ type: 'result', session_id: 'sess-fresh' }],
  codex: [
    { type: 'thread.started', thread_id: 'thread-fresh' },
    { type: 'agent_message', message: 'hello user' },
    { type: 'turn.completed' },
  ],
  kimi: [{ role: 'assistant', content: 'OK' }, KIMI_RESUME],
  grok: [{ type: 'text', data: 'OK' }, GROK_END],
  cursor: [
    CURSOR_INIT,
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
    },
    CURSOR_RESULT,
  ],
};

const FRESH_EVENTS: Record<AgentKind, AgentEvent[]> = {
  claude: [{ type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' }],
  codex: [
    { type: 'system', threadId: 'thread-fresh' },
    { type: 'final_text', content: 'hello user' },
    { type: 'done', threadId: 'thread-fresh', terminationReason: 'normal' },
  ],
  kimi: [
    { type: 'system', sessionId: 'session_fake' },
    { type: 'final_text', content: 'OK' },
    { type: 'done', sessionId: 'session_fake', terminationReason: 'normal' },
  ],
  grok: [
    { type: 'system', sessionId: GROK_SESSION },
    { type: 'final_text', content: 'OK' },
    { type: 'done', sessionId: GROK_SESSION, terminationReason: 'normal' },
  ],
  cursor: [
    { type: 'system', sessionId: CURSOR_SESSION, cwd: '/tmp', model: 'Composer 2.5' },
    { type: 'final_text', content: 'OK' },
    { type: 'done', sessionId: CURSOR_SESSION, terminationReason: 'normal' },
  ],
};

describe('JsonlCliRunner collapse', () => {
  it('keeps spawnProcess out of every adapter directory', () => {
    for (const kind of AGENT_KINDS) {
      const source = readFileSync(join('src/agent', kind, 'adapter.ts'), 'utf8');
      expect(source, kind).not.toMatch(/\bspawnProcess\b/);
    }
  });
});

describe.each(AGENT_KINDS)('JsonlCliRunner %s process contract', (kind) => {
  const cleanup: string[] = [];
  const oldCodexHome = process.env.CODEX_HOME;
  const oldAppSecret = process.env.APP_SECRET;

  afterEach(async () => {
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    if (oldAppSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = oldAppSecret;
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('creates a per-run translator from the descriptor', () => {
    const first = descriptorFor(kind).createTranslator();
    const second = descriptorFor(kind).createTranslator();
    expect(first).not.toBe(second);
    expect(first.translate('not-json')).toEqual([]);
  });

  it('spawns a fresh run and translates the kind JSONL fixture', async () => {
    if (kind === 'codex') {
      process.env.CODEX_HOME = '/outer/codex-home';
      process.env.APP_SECRET = 'inherited-secret';
    }
    const fake = await createFakeCli({ lines: FRESH_LINES[kind] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = createAdapter(kind, { binary: fake.path, dir: fake.dir, sandbox: 'read-only' });
    const run = adapter.run({
      runId: 'run-fresh',
      prompt: kind === 'codex' ? 'hello from lark' : 'hello',
      cwd,
      ...(kind === 'claude' ? { permissionMode: 'acceptEdits' } : {}),
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual(FRESH_EVENTS[kind]);
    const record = await readRecord(fake.recordPath);
    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.env.LARK_CHANNEL).toBe('1');
    await assertFreshArgv(kind, record, cwd);
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeCli({
      lines: kind === 'codex' ? [{ type: 'turn.completed' }] : FRESH_LINES[kind],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const profile = `${kind}-dev`;
    const larkCliConfigDir = join(rootDir, 'profiles', profile, 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', profile, 'lark-cli-source', 'config.json');
    const larkChannel: LarkChannelEnvContext = {
      profile,
      rootDir,
      configPath,
      larkCliConfigDir,
      larkCliSourceConfigFile,
    };
    const adapter = createAdapter(kind, { binary: fake.path, dir: fake.dir, larkChannel });
    await collect(
      adapter.run({
        runId: 'run-profile-env',
        prompt: 'profile',
        cwd: await realpath(fake.dir),
      }).events,
    );
    const record = await readRecord(fake.recordPath);
    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: profile,
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
    if (kind === 'grok') expect(record.env.GROK_DISABLE_AUTOUPDATER).toBe('1');
  });

  it('passes resume and model through the kind argv contract', async () => {
    const fake = await createFakeCli({
      lines:
        kind === 'codex'
          ? [{ type: 'turn.completed' }]
          : kind === 'claude'
            ? [{ type: 'result', session_id: 'sess-resumed' }]
            : FRESH_LINES[kind],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(fake.dir, 'image.png');
    const resume = resumeOptions(kind, image);
    const adapter = createAdapter(kind, {
      binary: fake.path,
      dir: fake.dir,
      sandbox: kind === 'codex' ? 'workspace-write' : undefined,
    });
    const events = await collect(adapter.run({ runId: 'run-resume', prompt: 'continue', cwd, ...resume }).events);
    if (kind === 'claude') {
      expect(events).toEqual([{ type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' }]);
    }
    const record = await readRecord(fake.recordPath);
    assertResumeArgv(kind, record, cwd, image);
  });

  it('includes stderr when the process exits non-zero before a terminal event', async () => {
    const fake = await createFakeCli({
      lines: failLines(kind),
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);
    const events = await collect(
      createAdapter(kind, { binary: fake.path, dir: fake.dir }).run({
        runId: 'run-fail',
        prompt: 'fail',
        cwd: await realpath(fake.dir),
      }).events,
    );
    expect(events).toEqual(failEvents(kind));
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<AgentAdapter['run']>;
    if (process.platform === 'win32' && (kind === 'claude' || kind === 'codex')) {
      const fake = await createFakeCli({ lines: [], stderr: 'missing command\n', exitCode: 1 });
      cleanup.push(fake.dir);
      run = createAdapter(kind, { binary: fake.path, dir: fake.dir }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: await realpath(fake.dir),
      });
    } else {
      const missing = join(tmpdir(), `missing-${kind}-${Date.now()}`);
      run = createAdapter(kind, { binary: missing, dir: tmpdir() }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }
    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      new RegExp(`failed to spawn ${kind}|spawn returned no pid|${kind} exited with code`),
    );
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      createAdapter(kind, { binary: 'unused', dir: tmpdir() }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

describe('JsonlCliRunner abort and timeouts', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('abort emits an error event and does not leak the child', async () => {
    const fake = await createFakeCli({ lines: [], hang: true });
    cleanup.push(fake.dir);
    const controller = new AbortController();
    const handle = runJsonlCli({
      binaryPath: fake.path,
      argv: [],
      cwd: fake.dir,
      env: process.env,
      translator: new RecordingTranslator(),
      signal: controller.signal,
      timeouts: { idleMs: 0, totalMs: 0 },
      name: 'probe',
      stopGraceMs: 50,
    });
    const iterator = handle.events[Symbol.asyncIterator]();
    controller.abort(new JsonlRunAborted('abort', 'probe run aborted'));
    const next = await iterator.next();
    expect(next.done).toBe(false);
    expect(next.value).toMatchObject({
      type: 'error',
      terminationReason: 'interrupted',
    });
    expect(await handle.waitForExit(1_000)).toBe(true);
  });

  it('idle timeout emits an error event and does not leak the child', async () => {
    const fake = await createFakeCli({ lines: [], hang: true });
    cleanup.push(fake.dir);
    const handle = runJsonlCli({
      binaryPath: fake.path,
      argv: [],
      cwd: fake.dir,
      env: process.env,
      translator: new RecordingTranslator(),
      signal: new AbortController().signal,
      timeouts: { idleMs: 40, totalMs: 0 },
      name: 'probe',
      stopGraceMs: 50,
    });
    const events = await collect(handle.events);
    expect(events).toEqual([
      {
        type: 'error',
        message: 'probe idle timeout',
        terminationReason: 'timeout',
      },
    ]);
    expect(await handle.waitForExit(1_000)).toBe(true);
  });

  it('always runs cleanup after a successful stream', async () => {
    const fake = await createFakeCli({ lines: [{ type: 'ok' }] });
    cleanup.push(fake.dir);
    const calls: string[] = [];
    const handle = runJsonlCli({
      binaryPath: fake.path,
      argv: [],
      cwd: fake.dir,
      env: process.env,
      translator: new RecordingTranslator(),
      cleanup: async () => {
        calls.push('cleanup');
      },
      signal: new AbortController().signal,
      timeouts: { idleMs: 0, totalMs: 0 },
      name: 'probe',
    });
    await collect(handle.events);
    expect(calls).toEqual(['cleanup']);
  });
});

describe('kind-specific argv and env extras', () => {
  const cleanup: string[] = [];
  const oldCodexHome = process.env.CODEX_HOME;

  afterEach(async () => {
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('claude waits for post-done process exit before stop fallback is needed', async () => {
    const fake = await createFakeCli({
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

  it('codex leaves CODEX_HOME unset by default so Codex can use the user login', async () => {
    delete process.env.CODEX_HOME;
    const fake = await createFakeCli({ lines: [{ type: 'turn.completed' }] });
    cleanup.push(fake.dir);
    await collect(
      new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
        runId: 'run-default-home',
        prompt: 'home',
        cwd: await realpath(fake.dir),
      }).events,
    );
    const record = await readRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBeUndefined();
  });

  it('codex honors a profile-configured Codex home and isolated home', async () => {
    const fake = await createFakeCli({ lines: [{ type: 'turn.completed' }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const codexHome = join(fake.dir, 'custom-codex-home');
    await collect(
      new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome }).run({
        runId: 'run-home',
        prompt: 'home',
        cwd,
      }).events,
    );
    expect((await readRecord(fake.recordPath)).env.CODEX_HOME).toBe(codexHome);

    process.env.CODEX_HOME = '/outer/codex-home';
    const isolated = await createFakeCli({ lines: [{ type: 'turn.completed' }] });
    cleanup.push(isolated.dir);
    await collect(
      new CodexAdapter({
        binary: isolated.path,
        profileStateDir: isolated.dir,
        inheritCodexHome: false,
      }).run({
        runId: 'run-profile-local-home',
        prompt: 'home',
        cwd: await realpath(isolated.dir),
      }).events,
    );
    expect((await readRecord(isolated.recordPath)).env.CODEX_HOME).toBe(join(isolated.dir, 'codex-home'));
  });

  it('codex lets per-run policy sandbox override the adapter default', async () => {
    const fake = await createFakeCli({ lines: [{ type: 'turn.completed' }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    await collect(
      new CodexAdapter({
        binary: fake.path,
        profileStateDir: fake.dir,
        sandbox: 'danger-full-access',
      }).run({
        runId: 'run-policy-sandbox',
        prompt: 'policy sandbox',
        cwd,
        sandbox: 'read-only',
      }).events,
    );
    expect((await readRecord(fake.recordPath)).argv).toEqual(buildCodexArgs({ cwd, sandbox: 'read-only' }));
  });

  it('codex passes ignore flags and can isolate the user config', async () => {
    const fake = await createFakeCli({ lines: [{ type: 'turn.completed' }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    await collect(
      new CodexAdapter({
        binary: fake.path,
        profileStateDir: fake.dir,
        ignoreUserConfig: false,
        ignoreRules: false,
      }).run({ runId: 'run-flags', prompt: 'flags', cwd }).events,
    );
    const record = await readRecord(fake.recordPath);
    expect(record.argv).not.toContain('--ignore-user-config');
    expect(record.argv).not.toContain('--ignore-rules');

    const isolated = await createFakeCli({ lines: [{ type: 'turn.completed' }] });
    cleanup.push(isolated.dir);
    await collect(
      new CodexAdapter({
        binary: isolated.path,
        profileStateDir: isolated.dir,
        ignoreUserConfig: true,
      }).run({
        runId: 'run-ignore-user-config',
        prompt: 'flags',
        cwd: await realpath(isolated.dir),
      }).events,
    );
    expect((await readRecord(isolated.recordPath)).argv).toContain('--ignore-user-config');
  });

  it('codex continues after retryable raw error events', async () => {
    const fake = await createFakeCli({
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
    expect(
      await collect(
        new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
          runId: 'run-retry',
          prompt: 'retry',
          cwd: await realpath(fake.dir),
        }).events,
      ),
    ).toEqual([
      { type: 'system', threadId: 'thread-retry' },
      { type: 'final_text', content: 'after retry' },
      { type: 'done', threadId: 'thread-retry', terminationReason: 'normal' },
    ]);
  });

  it('codex stop reports interrupted termination', async () => {
    const fake = await createFakeCli({
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

  it('kimi maps tool call lines and stop() interrupts a hung run', async () => {
    const tools = await createFakeCli({
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
        KIMI_RESUME,
      ],
    });
    cleanup.push(tools.dir);
    expect(
      await collect(
        new KimiAdapter({ binary: tools.path }).run({
          runId: 'run-tools',
          prompt: 'hi',
          cwd: tools.dir,
        }).events,
      ),
    ).toEqual([
      { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'echo hi' } },
      { type: 'tool_result', id: 'tool_1', output: 'hi\n', isError: false },
      { type: 'system', sessionId: 'session_fake' },
      { type: 'final_text', content: 'done' },
      { type: 'done', sessionId: 'session_fake', terminationReason: 'normal' },
    ]);

    const hung = await createFakeCli({ lines: [], hang: true });
    cleanup.push(hung.dir);
    const run = new KimiAdapter({ binary: hung.path, stopGraceMs: 50 }).run({
      runId: 'run-hang',
      prompt: 'hang',
      cwd: hung.dir,
    });
    await run.stop();
    expect(await collect(run.events)).toEqual([{ type: 'done', terminationReason: 'interrupted' }]);
  });

  it('grok maps tools, fails without an end event, and stop() interrupts a hung run', async () => {
    const tools = await createFakeCli({
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
        GROK_END,
      ],
    });
    cleanup.push(tools.dir);
    expect(
      await collect(
        new GrokAdapter({ binary: tools.path }).run({
          runId: 'run-tools',
          prompt: 'hi',
          cwd: tools.dir,
        }).events,
      ),
    ).toEqual([
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

    const orphan = await createFakeCli({ lines: [{ type: 'text', data: 'orphan' }] });
    cleanup.push(orphan.dir);
    expect(
      await collect(
        new GrokAdapter({ binary: orphan.path }).run({
          runId: 'run-no-end',
          prompt: 'hi',
          cwd: orphan.dir,
        }).events,
      ),
    ).toEqual([
      { type: 'text', delta: 'orphan\n\n' },
      {
        type: 'error',
        message: 'grok stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);

    const hung = await createFakeCli({ lines: [], hang: true });
    cleanup.push(hung.dir);
    const run = new GrokAdapter({ binary: hung.path, stopGraceMs: 50 }).run({
      runId: 'run-hang',
      prompt: 'hang',
      cwd: hung.dir,
    });
    await run.stop();
    expect(await collect(run.events)).toEqual([{ type: 'done', terminationReason: 'interrupted' }]);
  });

  it('cursor fails without a result, refuses restricted sandbox, and stop() interrupts a hung run', async () => {
    const orphan = await createFakeCli({
      lines: [
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'orphan' }] },
        },
      ],
    });
    cleanup.push(orphan.dir);
    expect(
      await collect(
        new CursorAdapter({ binary: orphan.path }).run({
          runId: 'run-no-result',
          prompt: 'hi',
          cwd: orphan.dir,
        }).events,
      ),
    ).toEqual([
      { type: 'text', delta: 'orphan\n\n' },
      {
        type: 'error',
        message: 'cursor stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);

    expect(() =>
      new CursorAdapter({ binary: 'unused' }).run({
        runId: 'run-ro',
        prompt: 'hi',
        cwd: tmpdir(),
        sandbox: 'read-only',
      }),
    ).toThrow(/only supports full access/);

    const hung = await createFakeCli({ lines: [], hang: true });
    cleanup.push(hung.dir);
    const run = new CursorAdapter({ binary: hung.path, stopGraceMs: 50 }).run({
      runId: 'run-hang',
      prompt: 'hang',
      cwd: hung.dir,
    });
    await run.stop();
    expect(await collect(run.events)).toEqual([{ type: 'done', terminationReason: 'interrupted' }]);
  });
});

class RecordingTranslator implements JsonlTranslator {
  translate(line: string): AgentEvent[] {
    const parsed = parseJsonlLine(line);
    if (parsed === undefined) return [];
    return [{ type: 'text', delta: JSON.stringify(parsed) }];
  }

  finish(): AgentEvent[] {
    return [{ type: 'done', terminationReason: 'normal' }];
  }

  fail(error: unknown): AgentEvent[] {
    if (error instanceof JsonlRunAborted && error.causeKind === 'stop') {
      return [{ type: 'done', terminationReason: 'interrupted' }];
    }
    if (error instanceof JsonlRunAborted && error.causeKind === 'timeout') {
      return [{ type: 'error', message: error.message, terminationReason: 'timeout' }];
    }
    if (error instanceof JsonlRunAborted && error.causeKind === 'abort') {
      return [{ type: 'error', message: error.message, terminationReason: 'interrupted' }];
    }
    const message = error instanceof Error ? error.message : String(error);
    return [{ type: 'error', message, terminationReason: 'failed' }];
  }
}

function createAdapter(
  kind: AgentKind,
  opts: {
    binary: string;
    dir: string;
    larkChannel?: LarkChannelEnvContext;
    stopGraceMs?: number;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    codexHome?: string;
    inheritCodexHome?: boolean;
  },
): AgentAdapter {
  switch (kind) {
    case 'claude':
      return new ClaudeAdapter({ binary: opts.binary, larkChannel: opts.larkChannel });
    case 'codex':
      return new CodexAdapter({
        binary: opts.binary,
        profileStateDir: opts.dir,
        sandbox: opts.sandbox ?? 'read-only',
        larkChannel: opts.larkChannel,
        ...(opts.stopGraceMs !== undefined ? { stopGraceMs: opts.stopGraceMs } : {}),
        ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
        ...(opts.inheritCodexHome !== undefined ? { inheritCodexHome: opts.inheritCodexHome } : {}),
      });
    case 'kimi':
      return new KimiAdapter({
        binary: opts.binary,
        larkChannel: opts.larkChannel,
        ...(opts.stopGraceMs !== undefined ? { stopGraceMs: opts.stopGraceMs } : {}),
      });
    case 'grok':
      return new GrokAdapter({
        binary: opts.binary,
        larkChannel: opts.larkChannel,
        ...(opts.stopGraceMs !== undefined ? { stopGraceMs: opts.stopGraceMs } : {}),
      });
    case 'cursor':
      return new CursorAdapter({
        binary: opts.binary,
        larkChannel: opts.larkChannel,
        ...(opts.stopGraceMs !== undefined ? { stopGraceMs: opts.stopGraceMs } : {}),
      });
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${String(exhaustive)}`);
    }
  }
}

async function assertFreshArgv(kind: AgentKind, record: FakeRecord, cwd: string): Promise<void> {
  switch (kind) {
    case 'claude': {
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
      expect(record.systemPrompt).not.toContain('__claude_cb');
      expect(record.argv).not.toContain('--resume');
      expect(record.argv).not.toContain('--model');
      expect(buildClaudeArgs({
        permissionMode: 'acceptEdits',
        systemPromptFile: record.argv[7] ?? '',
      }).slice(0, 7)).toEqual(record.argv.slice(0, 7));
      return;
    }
    case 'codex': {
      expect(record.argv).toEqual(buildCodexArgs({ cwd, sandbox: 'read-only' }));
      expect(record.argv).not.toContain('hello from lark');
      expect(record.stdin).toContain('lark-channel-bridge 运行约定');
      expect(record.stdin).toContain('hello from lark');
      expect(record.env.CODEX_HOME).toBe('/outer/codex-home');
      expect(record.env.APP_SECRET).toBe('inherited-secret');
      return;
    }
    case 'kimi': {
      expect(record.argv[0]).toBe('-p');
      expect(record.argv.slice(2, 4)).toEqual(['--output-format', 'stream-json']);
      expect(record.argv[1]).toContain('lark-channel-bridge 运行约定');
      expect(record.argv[1]).toContain('## user_message\n\nhello');
      expect(record.argv).not.toContain('-S');
      expect(record.argv).not.toContain('-m');
      return;
    }
    case 'grok': {
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
      return;
    }
    case 'cursor': {
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
      return;
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${String(exhaustive)}`);
    }
  }
}

function resumeOptions(kind: AgentKind, image: string): Partial<AgentRunOptions> {
  switch (kind) {
    case 'claude':
      return { sessionId: 'sess-old', model: 'sonnet' };
    case 'codex':
      return { threadId: 'thread-old', images: [image] };
    case 'kimi':
      return { sessionId: 'session_old', model: 'kimi-code/kimi-for-coding' };
    case 'grok':
      return { sessionId: GROK_SESSION, model: 'grok-build' };
    case 'cursor':
      return { sessionId: 'session_old', model: 'composer-2.5' };
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${String(exhaustive)}`);
    }
  }
}

function assertResumeArgv(kind: AgentKind, record: FakeRecord, cwd: string, image: string): void {
  switch (kind) {
    case 'claude':
      expect(record.argv.slice(-4)).toEqual(['--resume', 'sess-old', '--model', 'sonnet']);
      expect(record.argv[5]).toBe('bypassPermissions');
      return;
    case 'codex':
      expect(record.argv).toEqual(
        buildCodexArgs({
          cwd,
          sandbox: 'workspace-write',
          threadId: 'thread-old',
          images: [image],
        }),
      );
      return;
    case 'kimi':
      expect(record.argv.slice(-4)).toEqual(['-S', 'session_old', '-m', 'kimi-code/kimi-for-coding']);
      return;
    case 'grok':
      expect(record.argv.slice(-4)).toEqual(['-r', GROK_SESSION, '-m', 'grok-build']);
      expect(record.argv).not.toContain('-s');
      return;
    case 'cursor':
      expect(record.argv).toContain('--resume');
      expect(record.argv[record.argv.indexOf('--resume') + 1]).toBe('session_old');
      expect(record.argv).toContain('--model');
      expect(record.argv[record.argv.indexOf('--model') + 1]).toBe('composer-2.5');
      expect(record.argv.at(-1)).toContain('## user_message\n\ncontinue');
      return;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${String(exhaustive)}`);
    }
  }
}

function failLines(kind: AgentKind): unknown[] {
  switch (kind) {
    case 'claude':
      return [{ type: 'assistant', message: { content: [{ type: 'text', text: 'before failure' }] } }];
    case 'codex':
      return [{ type: 'agent_message', message: 'before failure' }];
    case 'kimi':
      return [{ role: 'assistant', content: 'before failure' }];
    case 'grok':
      return [{ type: 'text', data: 'before failure' }];
    case 'cursor':
      return [
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'before failure' }] },
        },
      ];
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${String(exhaustive)}`);
    }
  }
}

function failEvents(kind: AgentKind): AgentEvent[] {
  switch (kind) {
    case 'claude':
      return [
        { type: 'text', delta: 'before failure' },
        { type: 'error', message: 'claude exited with code 42: boom', terminationReason: 'failed' },
      ];
    case 'codex':
      return [
        { type: 'text', delta: 'before failure' },
        { type: 'error', message: 'codex exited with code 42: boom', terminationReason: 'failed' },
      ];
    case 'kimi':
      return [
        { type: 'text', delta: 'before failure\n\n' },
        { type: 'error', message: 'kimi exited with code 42: boom', terminationReason: 'failed' },
      ];
    case 'grok':
      return [
        { type: 'text', delta: 'before failure\n\n' },
        { type: 'error', message: 'grok exited with code 42: boom', terminationReason: 'failed' },
      ];
    case 'cursor':
      return [
        { type: 'text', delta: 'before failure\n\n' },
        { type: 'error', message: 'cursor exited with code 42: boom', terminationReason: 'failed' },
      ];
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${String(exhaustive)}`);
    }
  }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeCli(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
  hang?: boolean;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-cli-runner-test-'));
  const path = join(dir, 'fake-cli.mjs');
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
      'const finish = () => {',
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
      '      CODEX_HOME: process.env.CODEX_HOME,',
      '      APP_SECRET: process.env.APP_SECRET,',
      '      GROK_DISABLE_AUTOUPDATER: process.env.GROK_DISABLE_AUTOUPDATER,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      options.hang
        ? '  setInterval(() => {}, 1000);'
        : `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '};',
      'if (process.stdin.readableEnded) finish();',
      'else process.stdin.on("end", finish);',
    ]
      .filter(Boolean)
      .join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<FakeRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as FakeRecord;
}
