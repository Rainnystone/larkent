import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { down, freezeBridge, killCli } from '../../../e2e/test-bridge/driver';
import { pidFilePath } from '../../../e2e/test-bridge/paths';
import { writePidFile } from '../../../e2e/test-bridge/pidfile';

const posix = process.platform !== 'win32';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!posix)('e2e driver live pidfile', () => {
  it('fails loudly from down when the pidfile process is dead', async () => {
    const dir = await tmp('e2e-down-dead-');
    await writeDeadPidFile(dir);
    await expect(down(dir)).rejects.toThrow(/not running/);
  });

  it('fails loudly from ws-freeze when the pidfile process is dead', async () => {
    const dir = await tmp('e2e-freeze-dead-');
    await writeDeadPidFile(dir);
    await expect(freezeBridge(dir, true)).rejects.toThrow(/not running/);
  });

  it('fails loudly from kill-cli when the pidfile process is dead', async () => {
    const dir = await tmp('e2e-kill-dead-');
    await writeDeadPidFile(dir);
    await expect(killCli(dir, 'child-only')).rejects.toThrow(/not running/);
  });
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function writeDeadPidFile(dir: string): Promise<void> {
  const pid = await spawnDeadPid();
  await writePidFile(pidFilePath(dir), {
    pid,
    instance: 'test',
    rootDir: dir,
    cmdline: `lark-channel-e2e ${dir}`,
    startedAt: new Date().toISOString(),
  });
}

function spawnDeadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    child.once('error', reject);
    child.once('exit', () => {
      if (!child.pid) {
        reject(new Error('dead pid helper did not spawn'));
        return;
      }
      resolve(child.pid);
    });
  });
}
