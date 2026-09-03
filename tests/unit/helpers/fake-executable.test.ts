import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnProcessSync } from '../../../src/platform/spawn.js';
import { writeScriptedJsonlExecutable, writeScriptedJsonlExecutableFile } from '../../helpers/fake-executable.js';
import { stabilizePinSnapshot } from '../../helpers/scripted-jsonl-cli.js';

describe('scripted JSONL fake executables', () => {
  it('writes a cmd file as a node launcher, not a shebang script', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pin-cmd-wrapper-'));
    const file = join(dir, 'grok.CMD');
    await writeScriptedJsonlExecutableFile(file, join(dir, 'argv.json'), {
      lines: [{ type: 'text', data: 'ok' }],
    });
    const launcher = await readFile(file, 'utf8');
    expect(launcher.startsWith('@echo off')).toBe(true);
    expect(launcher).toContain(process.execPath);
    expect(launcher).toContain('grok.mjs');
    expect(launcher).not.toContain('import {');
  });

  it('installs a spawnable command and a rewriteable JSONL script sidecar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pin-script-path-'));
    const fake = await writeScriptedJsonlExecutable(dir, 'grok', {
      lines: [{ type: 'text', data: 'ok' }],
    });
    expect(fake.path.toLowerCase().endsWith('.cmd')).toBe(process.platform === 'win32');
    expect(fake.scriptPath.endsWith('.script.json')).toBe(true);
    const nodeSource = fake.path.toLowerCase().endsWith('.cmd')
      ? fake.path.replace(/\.cmd$/i, '.mjs')
      : fake.path;
    const source = await readFile(nodeSource, 'utf8');
    expect(source.startsWith('#!')).toBe(true);
    const script = JSON.parse(await readFile(fake.scriptPath, 'utf8')) as { lines: unknown[] };
    expect(script.lines).toEqual([{ type: 'text', data: 'ok' }]);
    const version = spawnProcessSync(fake.path, ['--version'], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(String(version.stdout)).toContain('0.0.0-pin');
  });

  it('records grok argv through spawn, including a rules blob with angle brackets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pin-grok-argv-'));
    const fake = await writeScriptedJsonlExecutable(dir, 'grok', {
      lines: [{ type: 'end', stopReason: 'end_turn' }],
    });
    const rules = 'before\n<bridge_context>\nafter';
    const nodeSource = fake.path.toLowerCase().endsWith('.cmd')
      ? fake.path.replace(/\.cmd$/i, '.mjs')
      : fake.path;
    const result = spawnProcessSync(
      process.execPath,
      [nodeSource, '-p', 'please succeed', '--output-format', 'streaming-json', '--rules', rules],
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
