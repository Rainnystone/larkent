import { once } from 'node:events';
import { mkdtemp, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnProcess, spawnProcessSync } from '../../../src/platform/spawn.js';
import { writeScriptedJsonlExecutable, writeScriptedJsonlExecutableFile } from '../../helpers/fake-executable.js';
import { installControlledKindCli } from '../../helpers/controlled-kind-cli.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';
import { stabilizePinSnapshot } from '../../helpers/scripted-jsonl-cli.js';

describe('scripted JSONL fake executables', () => {
  it('drains and records a non-controlled Codex prompt before emitting terminal output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fake-codex-stdin-'));
    try {
      const terminal = { type: 'turn.completed', usage: {} };
      const fake = await writeScriptedJsonlExecutable(dir, 'codex', { lines: [terminal] });
      const prompt = 'actual fixture prompt\n'.repeat(32768);
      const result = spawnProcessSync(fake.path, ['exec', '--json', '-'], {
        encoding: 'utf8', input: prompt, maxBuffer: 1024 * 1024,
      });
      expect(result.error).toBeFalsy();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(String(result.stdout))).toEqual(terminal);
      const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as { stdin: string; argv: string[] };
      expect(record.stdin).toBe(prompt);
      expect(record.argv).toEqual(['exec', '--json', '-']);
      const help = spawnProcessSync(fake.path, ['--help'], { encoding: 'utf8' });
      expect(help.status).toBe(0);
      expect(String(help.stdout)).toContain('Usage: fake-cli');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a non-controlled Codex hang alive after draining its prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fake-codex-hang-'));
    const fake = await writeScriptedJsonlExecutable(dir, 'codex', {
      lines: [{ type: 'thread.started', thread_id: 'hang-fixture' }], hang: true,
    });
    const child = spawnProcess(fake.path, ['exec', '--json', '-']);
    const closed = once(child, 'close');
    try {
      const output = once(child.stdout!, 'data');
      child.stdin!.end('hang prompt');
      await output;
      const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as { stdin: string };
      expect(record.stdin).toBe('hang prompt');
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      child.kill();
      await closed;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes a cmd file as a launcher, not a shebang script', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pin-cmd-wrapper-'));
    const file = join(dir, 'grok.CMD');
    await writeScriptedJsonlExecutableFile(file, join(dir, 'argv.json'), {
      lines: [{ type: 'text', data: 'ok' }],
    });
    const launcher = await readFile(file, 'utf8');
    expect(launcher.startsWith('@echo off')).toBe(true);
    expect(launcher).toMatch(/grok\.mjs/i);
    expect(launcher).not.toContain('import {');
  });

  it('returns a node script path so spawn does not go through cmd.exe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pin-script-path-'));
    const fake = await writeScriptedJsonlExecutable(dir, 'grok', {
      lines: [{ type: 'text', data: 'ok' }],
    });
    expect(fake.path.toLowerCase().endsWith('.cmd')).toBe(false);
    expect(fake.scriptPath).toBe(`${fake.path}.script.json`);
    const source = await readFile(fake.path, 'utf8');
    expect(source.startsWith('#!')).toBe(true);
    const script = JSON.parse(await readFile(fake.scriptPath, 'utf8')) as { lines: unknown[] };
    expect(script.lines).toEqual([{ type: 'text', data: 'ok' }]);
    if (process.platform === 'win32') {
      const launcher = await readFile(join(dir, 'grok.CMD'), 'utf8');
      expect(launcher.startsWith('@echo off')).toBe(true);
      expect(launcher).toMatch(/grok\.mjs/i);
      expect(launcher).not.toContain('import {');
    }
    const version = spawnProcessSync(fake.path, ['--version'], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(String(version.stdout)).toContain('0.0.0-pin');
  });

  it('PATH-resolves the base name so ClaudeAdapter can spawn claude', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pin-path-claude-'));
    const fake = await writeScriptedJsonlExecutable(dir, 'claude', {
      lines: [{ type: 'end', stopReason: 'end_turn' }],
    });
    const previous = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${previous ?? ''}`;
    try {
      const result = spawnProcessSync('claude', ['--version'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(String(result.stdout)).toContain('0.0.0-pin');
      expect(fake.path.toLowerCase().endsWith('.cmd')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  it('records grok argv through spawn, including a rules blob with angle brackets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pin-grok-argv-'));
    const fake = await writeScriptedJsonlExecutable(dir, 'grok', {
      lines: [{ type: 'end', stopReason: 'end_turn' }],
    });
    const rules = 'before\n<bridge_context>\nafter';
    const result = spawnProcessSync(
      fake.path,
      ['-p', 'please succeed', '--output-format', 'streaming-json', '--rules', rules],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as { argv: string[] };
    expect(record.argv).toEqual([
      '-p',
      'please succeed',
      '--output-format',
      'streaming-json',
      '--rules',
      rules,
    ]);
  });
});

describe('stabilizePinSnapshot', () => {
  it('replaces JSON-escaped Windows paths', () => {
    const cwd = 'C:\\Users\\runner\\AppData\\Local\\Temp\\pin';
    const actual = stabilizePinSnapshot({ cwd }, [[cwd, '<cwd>']]);
    expect(actual).toEqual({ cwd: '<cwd>' });
  });

  it('normalizes truncated resume nonce tokens', () => {
    const actual = stabilizePinSnapshot({
      text: '/resume use 12345678-abc',
      arg: '12345678-abc',
    });
    expect(actual).toEqual({
      text: '/resume use <nonce>',
      arg: '<nonce>',
    });
  });
});

describe('controlled Codex state boundary', () => {
  it.each(['missing', 'outside', 'symlink escape'] as const)('rejects %s CODEX_HOME before writing state', async location => {
    const tmp = await createTmpProfile('controlled-state-');
    const outside = await createTmpProfile('controlled-outside-');
    try {
      const fake = await installControlledKindCli(tmp.root, 'codex', 'A');
      await fake.release();
      const linkedHome = join(tmp.root, 'linked-home');
      if (location === 'symlink escape') await symlink(outside.root, linkedHome, 'junction');
      const codexHome = location === 'missing' ? '' : location === 'outside' ? outside.root : linkedHome;
      const result = spawnProcessSync(fake.path, ['exec', '--json', '-'], {
        encoding: 'utf8', input: 'test prompt',
        env: { ...process.env, CODEX_HOME: codexHome },
      });
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toContain('controlled Codex state requires CODEX_HOME inside fixture root');
      expect((await readdir(outside.root)).sort()).toEqual(['profile', 'workspace']);
    } finally { await tmp.cleanup(); await outside.cleanup(); }
  });
});
