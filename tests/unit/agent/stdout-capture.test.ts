import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPTURE_MAX_BYTES,
  STDOUT_CAPTURE_ENV,
  openStdoutCapture,
  redactStdoutLine,
  stdoutCaptureDirFromEnv,
} from '../../../src/agent/runner/stdout-capture';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const SECRET_LINE = JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: 'conv-1',
    step_index: 2,
    state: 'ACTIVE',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: {
      name: 'run_command',
      parameters: {
        CommandLine: "curl -H 'Authorization: Bearer sk-secret-token' https://example.test",
        token: 'sk-secret-token',
      },
      output: 'secret-output-should-not-leak',
    },
  },
  prompt: 'do not persist this prompt',
});

describe('opt-in stdout capture redaction', () => {
  it('does not write secrets, prompts, or tool payloads into the capture file', async () => {
    const dir = await tempDir('stdout-cap-secret-');
    const capture = openStdoutCapture({
      dir,
      runId: 'run-secret',
      spawnName: 'agy',
    });
    capture.noteLine(SECRET_LINE);
    capture.close();

    const body = await readFile(capture.path, 'utf8');
    expect(body).not.toContain('sk-secret-token');
    expect(body).not.toContain('secret-output-should-not-leak');
    expect(body).not.toContain('do not persist this prompt');
    expect(body).not.toContain('Bearer sk-secret');
    expect(body).toContain('"step_type":"tool"');
    expect(body).toContain('"state":"ACTIVE"');
    expect(body).toContain('"step_index":2');
    expect(body).toContain('"tool_name":"run_command"');
  });

  it('redacts payload fields while keeping pairing identity keys', () => {
    const redacted = redactStdoutLine(SECRET_LINE);
    expect(redacted).toEqual(expect.objectContaining({
      event: 'step_update',
      step_update: expect.objectContaining({
        conversation_id: 'conv-1',
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
      }),
    }));
    const asText = JSON.stringify(redacted);
    expect(asText).not.toContain('sk-secret-token');
    expect(asText).not.toContain('secret-output-should-not-leak');
  });

  it('creates the capture file with owner-only permissions', async () => {
    const dir = await tempDir('stdout-cap-mode-');
    const capture = openStdoutCapture({
      dir,
      runId: 'run-mode',
      spawnName: 'agy',
    });
    capture.noteLine('{"event":"init"}');
    capture.close();
    const fileMode = (await stat(capture.path)).mode & 0o777;
    const dirMode = (await stat(dir)).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    }
  });

  it('writes a truncation record and stops before exceeding the byte bound', async () => {
    const dir = await tempDir('stdout-cap-limit-');
    const capture = openStdoutCapture({
      dir,
      runId: 'run-limit',
      spawnName: 'agy',
      maxBytes: 400,
    });
    for (let i = 0; i < 50; i++) {
      capture.noteLine(JSON.stringify({ event: 'step_update', i, pad: 'x'.repeat(80) }));
    }
    capture.close();
    const body = await readFile(capture.path, 'utf8');
    const bytes = Buffer.byteLength(body, 'utf8');
    expect(bytes).toBeLessThanOrEqual(400);
    expect(body).toContain('"truncated":true');
    expect(DEFAULT_CAPTURE_MAX_BYTES).toBeGreaterThan(400);
  });

  it('records a write error without throwing into the CLI runner', async () => {
    const dir = await tempDir('stdout-cap-err-');
    const capture = openStdoutCapture({
      dir,
      runId: 'run-err',
      spawnName: 'agy',
    });
    await rm(dir, { recursive: true, force: true });
    expect(() => capture.noteLine('{"event":"init"}')).not.toThrow();
    expect(() => capture.noteError('disk full')).not.toThrow();
    expect(() => capture.close()).not.toThrow();
  });

  it('prunes oldest captures when the retention file cap is exceeded', async () => {
    const dir = await tempDir('stdout-cap-retain-');
    for (const name of ['old-a', 'old-b', 'old-c']) {
      const path = join(dir, `${name}.jsonl`);
      await writeFile(path, '{}\n', { mode: 0o600 });
      const age = name === 'old-a' ? 30_000 : name === 'old-b' ? 20_000 : 10_000;
      const atime = new Date(Date.now() - age);
      await utimes(path, atime, atime);
    }
    const capture = openStdoutCapture({
      dir,
      runId: 'run-new',
      spawnName: 'agy',
      maxFiles: 2,
    });
    capture.noteLine('{"event":"init"}');
    capture.close();
    const names = (await readdir(dir)).sort();
    expect(names).toContain(capture.path.slice(dir.length + 1));
    expect(names.length).toBeLessThanOrEqual(2);
    expect(names).not.toContain('old-a.jsonl');
  });

  it('is disabled unless the opt-in directory env is set', () => {
    expect(stdoutCaptureDirFromEnv({})).toBeUndefined();
    expect(stdoutCaptureDirFromEnv({ [STDOUT_CAPTURE_ENV]: '' })).toBeUndefined();
    expect(stdoutCaptureDirFromEnv({ [STDOUT_CAPTURE_ENV]: '/tmp/captures' })).toBe('/tmp/captures');
  });
});
