import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runJsonlCli, wrapParsedTranslator } from '../../../src/agent/runner/jsonl-cli-runner';

const FIXTURE = new URL('../../fixtures/grok/group-leader.mjs', import.meta.url);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return pid;
    } catch {
      // The leader has not written the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('sleep pid was not published');
}

describe('jsonl stop signals the process group', () => {
  const dirs: string[] = [];
  const groups: number[] = [];

  afterEach(() => {
    for (const pid of groups.splice(0)) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reaps the grandchild sleep after stop() and the grace period', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-grok-group-'));
    dirs.push(dir);
    const pidFile = join(dir, 'sleep.pid');
    const run = runJsonlCli({
      runId: 'group',
      binaryPath: process.execPath,
      argv: [FIXTURE.pathname, pidFile],
      cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp' },
      spawnName: 'fixture',
      stopGraceMs: 400,
      translator: wrapParsedTranslator({ translate: () => [] }, 'fixture'),
    });
    if (run.pid) groups.push(run.pid);
    const sleepPid = await waitForPid(pidFile);
    expect(alive(sleepPid)).toBe(true);
    await run.stop();
    expect(alive(sleepPid)).toBe(false);
    if (run.pid) expect(alive(run.pid)).toBe(false);
  });
});
