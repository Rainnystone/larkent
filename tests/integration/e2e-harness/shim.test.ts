import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runJsonlCli, wrapParsedTranslator } from '../../../src/agent/runner/jsonl-cli-runner';
import { RunCleanupFailed } from '../../../src/runtime/errors';
import {
  writeScriptedJsonlExecutable,
  writeVersionExecutable,
} from '../../helpers/fake-executable';
import { parseShimDecision, serializeShimDecision } from '../../../e2e/test-bridge/decide';
import { armFault, shimEntryPath } from '../../../e2e/test-bridge/shim';

const posix = process.platform !== 'win32';
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })),
  );
});

describe.skipIf(!posix)('test-bridge shim', () => {
  it('passthrough keeps a multiline prompt as one argv entry', async () => {
    const root = await tmp('shim-multiline-');
    const target = await writeEchoArgv(root);
    const prompt = 'line1\nline2 --flag\nthird';
    const result = await runShim(root, target, ['--prompt', prompt]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['--prompt', prompt]);
  });

  it('passthrough --version reaches the target executable', async () => {
    const root = await tmp('shim-version-');
    const target = await writeVersionExecutable(root, 'fake-cli', '9.9.9-shim-target');
    const result = await runShim(root, target, ['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('9.9.9-shim-target');
  });

  it('passthrough --help reaches the target executable even when a fault is armed', async () => {
    const root = await tmp('shim-help-');
    const fake = await writeScriptedJsonlExecutable(root, 'fake-cli', {
      helpText: 'Usage: fake-cli',
      version: '0.0.0-pin',
    });
    await armFault(root, { mode: 'cursor-stall', runId: '1' });
    const result = await runShim(root, fake.path, ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Usage: fake-cli/);
    expect(result.stderr).not.toMatch(/Connection stalled/);
  });

  it('forwards SIGTERM to the real child and does not trip stdout-did-not-quiesce', { timeout: 20_000 }, async () => {
    const root = await tmp('shim-term-');
    const fake = await writeScriptedJsonlExecutable(root, 'fake-cli', {
      hang: true,
      readyPath: join(root, 'ready'),
      lines: [{ type: 'text', delta: 'READY' }],
    });
    const translator = wrapParsedTranslator(
      {
        translate: (parsed) => [parsed as { type: 'text'; delta: string }],
        finish: (reason) => [
          { type: 'done', terminationReason: reason === 'interrupted' ? 'interrupted' : 'normal' },
        ],
      },
      'e2e-shim',
    );
    const run = runJsonlCli({
      runId: 'shim-term',
      binaryPath: shimEntryPath(),
      argv: [],
      cwd: root,
      env: shimEnv(root, fake.path),
      translator,
      spawnName: 'e2e-shim',
      stopGraceMs: 2000,
    });
    const iterator = run.events[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      expect(first.value).toMatchObject({ type: 'text', delta: 'READY' });
      await run.stop();
      expect(await run.waitForExit(2_000)).toBe(true);
    } catch (err) {
      if (err instanceof RunCleanupFailed) {
        expect(err.message).not.toMatch(/stdout did not quiesce/);
      }
      throw err;
    } finally {
      await run.stop().catch(() => {});
      await iterator.return?.();
    }
  });

  it('applies a one-shot fault only to the matching run id', { timeout: 20_000 }, async () => {
    const root = await tmp('shim-fault-');
    const fake = await writeScriptedJsonlExecutable(root, 'fake-cli', {
      version: '0.0.0-pin',
      lines: [{ type: 'result', subtype: 'success' }],
    });
    await armFault(root, { mode: 'cursor-stall', runId: '2' });

    const first = await runShim(root, fake.path, ['--version']);
    expect(first.stdout.trim()).toBe('0.0.0-pin');
    expect(first.stderr).not.toMatch(/Connection stalled/);

    const second = await runShim(root, fake.path, ['--prompt', 'go']);
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/RetriableError: Connection stalled repeatedly/);

    const third = await runShim(root, fake.path, ['--version']);
    expect(third.code).toBe(0);
    expect(third.stdout.trim()).toBe('0.0.0-pin');
    expect(third.stderr).not.toMatch(/Connection stalled/);
  });
});

describe('shim decision JSON', () => {
  it('round-trips a multiline prompt without splitting it into extra args', () => {
    const prompt = 'fix the bug\nthen run tests';
    const text = serializeShimDecision({
      action: 'exec',
      target: '/bin/echo',
      args: ['--prompt', prompt],
    });
    expect(text).not.toContain('\n--prompt');
    expect(parseShimDecision(text)).toEqual({
      action: 'exec',
      target: '/bin/echo',
      args: ['--prompt', prompt],
    });
  });
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

async function writeEchoArgv(dir: string): Promise<string> {
  const path = join(dir, 'echo-argv.mjs');
  await writeFile(path, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  await chmod(path, 0o755);
  return path;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function shimEnv(faultDir: string, target: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LARKENT_E2E_FAULT_DIR: faultDir,
    LARKENT_E2E_SHIM_TARGET: target,
    LARKENT_E2E_REPO_ROOT: repoRoot,
    LARKENT_E2E_TSX: join(repoRoot, 'node_modules', '.bin', 'tsx'),
  };
}

function runShim(
  faultDir: string,
  target: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(shimEntryPath(), args, {
      env: shimEnv(faultDir, target),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}
