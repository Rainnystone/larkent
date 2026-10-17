import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_CLI } from '../../../e2e/test-bridge/paths';
import { armFault, shimEntryPath } from '../../../e2e/test-bridge/shim';

const posix = process.platform !== 'win32';
const dirs: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!posix)('fake CLI arm hang', () => {
  it('keeps the process alive instead of exiting after about 1s', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-hang-'));
    dirs.push(dir);
    await armFault(dir, { mode: 'hang', sticky: true });
    const child = spawn(shimEntryPath(), ['--prompt', 'hang please'], {
      env: {
        ...process.env,
        LARKENT_E2E_FAULT_DIR: dir,
        LARKENT_E2E_SHIM_TARGET: FAKE_CLI,
        LARKENT_E2E_REPO_ROOT: repoRoot,
        LARKENT_E2E_TSX: join(repoRoot, 'node_modules', '.bin', 'tsx'),
      },
      stdio: 'ignore',
    });
    const pid = child.pid;
    expect(pid).toEqual(expect.any(Number));
    try {
      await sleep(1_500);
      expect(processAlive(pid!)).toBe(true);
      expect(child.exitCode).toBeNull();
    } finally {
      try {
        process.kill(pid!, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }, 15_000);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

