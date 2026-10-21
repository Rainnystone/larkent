import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLarkChannelEnv } from '../../../src/agent/lark-channel-env.js';
import { agentSpawnEnv, mergeProcessEnv, spawnProcess, spawnProcessSync } from '../../../src/platform/spawn.js';

describe('platform spawn env', () => {
  it('excludes exact bridge credential names regardless of casing or override source', () => {
    const base = {
      App_Secret: 'synthetic-app-secret',
      Wake_Webhook_Key: 'synthetic-wake-key',
      Wake_Webhook_Url: 'synthetic-wake-url',
      Sand_Box_Auth_Id: 'synthetic-platform-auth',
      Cloud_Agent_Injected_Secret_Names: 'synthetic-platform-secret-names',
      MCP_WEBHOOK_SECRET: 'synthetic-mcp-secret',
      GH_TOKEN: 'synthetic-old-token',
      LARK_BRIDGE_TOOL_TOKEN: 'synthetic-stale-token',
    };
    const env = agentSpawnEnv(base, {
      APP_SECRET: 'synthetic-override-secret',
      WAKE_WEBHOOK_KEY: 'synthetic-override-key',
      gh_token: 'synthetic-new-token',
      LARK_BRIDGE_TOOL_TOKEN: undefined,
    });

    expect(env).toEqual({
      MCP_WEBHOOK_SECRET: 'synthetic-mcp-secret',
      gh_token: 'synthetic-new-token',
    });
    expect(base.App_Secret).toBe('synthetic-app-secret');
    expect(base.GH_TOKEN).toBe('synthetic-old-token');
  });

  it('runs tool subprocesses without inherited forced colors or the Node NO_COLOR warning', () => {
    for (const base of [
      { ...process.env, NO_COLOR: '1', FORCE_COLOR: '3' },
      { ...process.env, No_Color: '1', Force_Color: '3' },
    ]) {
      const child = spawnProcessSync(process.execPath, ['-e', 'console.log(42); console.error("real diagnostic"); process.exitCode = 2'], {
        env: mergeProcessEnv(base, buildLarkChannelEnv()), encoding: 'utf8',
      });
      expect(child.status).toBe(2);
      expect(child.stdout).toBe('42\n');
      expect(child.stderr).toBe('real diagnostic\n');
    }
  });

  it('overrides env keys case-insensitively for Windows-compatible CODEX_HOME handling', () => {
    const env = mergeProcessEnv(
      {
        Path: '/bin',
        Codex_Home: '/old-codex-home',
        LARK_CHANNEL: '0',
      },
      {
        CODEX_HOME: '/new-codex-home',
        LARK_CHANNEL: '1',
      },
    );

    expect(env.CODEX_HOME).toBe('/new-codex-home');
    expect(env.LARK_CHANNEL).toBe('1');
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'codex_home')).toEqual([
      'CODEX_HOME',
    ]);
  });

  it('detaches agent CLIs so a bridge SIGKILL leaves an orphan the journal can reap', async () => {
    const [spawnSource, runnerSource] = await Promise.all([
      readFile(new URL('../../../src/platform/spawn.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/agent/runner/jsonl-cli-runner.ts', import.meta.url), 'utf8'),
    ]);
    expect(spawnSource).toContain('Turn journal reaps agent CLI orphans');
    expect(runnerSource).toContain('stdio: [\'pipe\', \'pipe\', \'pipe\']');
    expect(runnerSource).toMatch(/detached:\s*true/);
  });

  it('adapters use cross-spawn without shell invocation', async () => {
    const [claudeSource, codexSource] = await Promise.all([
      readFile(new URL('../../../src/agent/claude/adapter.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/agent/codex/adapter.ts', import.meta.url), 'utf8'),
    ]);

    expect(claudeSource).toContain("from '../../platform/spawn'");
    expect(codexSource).toContain("from '../../platform/spawn'");
    expect(claudeSource).not.toContain("from 'node:child_process'");
    expect(codexSource).not.toContain("from 'node:child_process'");
    expect(claudeSource).not.toContain('shell: true');
    expect(codexSource).not.toContain('shell: true');
  });

  it('spawns a missing Windows path without wrapping cmd.exe', async () => {
    const source = await readFile(new URL('../../../src/platform/spawn.ts', import.meta.url), 'utf8');
    expect(source).toContain('missingWindowsPathSkipsCmdWrap');
    expect(source).toContain("from 'node:child_process'");
    expect(source).toContain('cmd.exe');
  });

  it('invokes an existing Windows .mjs stub through node instead of cmd.exe', async () => {
    const source = await readFile(new URL('../../../src/platform/spawn.ts', import.meta.url), 'utf8');
    expect(source).toContain('windowsExistingMjsUsesNode');
    expect(source).toContain('process.execPath');
  });

  it('preserves stdin and quoted argv when the .mjs stub path contains &', async () => {
    const root = await mkdtemp(join(tmpdir(), 'js spawn & '));
    const cwd = join(root, 'work & dir');
    const script = join(root, 'runtime & stub.mjs');
    const seen = join(root, 'seen.json');
    await mkdir(cwd);
    await writeFile(
      script,
      `#!${process.execPath}
import { writeFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin }));
`,
    );
    await chmod(script, 0o755);
    try {
      const argv = ['exec', '-c', 'approval_policy="never"', '-C', cwd, '-'];
      const child = spawnProcess(script, argv, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      child.stdin!.end('prompt-body', 'utf8');
      const [code, signal] = await once(child, 'exit');
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      const recorded = JSON.parse(await readFile(seen, 'utf8')) as {
        argv: string[];
        cwd: string;
        stdin: string;
      };
      expect(recorded.argv).toEqual(argv);
      expect(recorded.stdin).toBe('prompt-body');
      expect(await realpath(recorded.cwd)).toBe(await realpath(cwd));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });
});
