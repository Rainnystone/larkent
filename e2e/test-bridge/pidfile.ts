import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

export interface TestBridgePidFile {
  pid: number;
  instance: string;
  rootDir: string;
  cmdline: string;
  proxyPid?: number;
  startedAt: string;
}

export class PidFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PidFileError';
  }
}

export async function writePidFile(path: string, data: TestBridgePidFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export async function readPidFile(path: string): Promise<TestBridgePidFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as TestBridgePidFile;
    if (!parsed || typeof parsed.pid !== 'number' || !parsed.rootDir) {
      throw new PidFileError(`invalid pid file: ${path}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PidFileError(`pid file not found: ${path}`);
    }
    throw err;
  }
}

export function readProcessCmdline(pid: number): string {
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\u0000/g, ' ');
    } catch {
      throw new PidFileError(`process ${pid} is not running`);
    }
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
  } catch {
    throw new PidFileError(`process ${pid} is not running`);
  }
}

export function assertTestInstanceCmdline(cmdline: string, rootDir: string): void {
  const belongs =
    cmdline.includes(rootDir) ||
    cmdline.includes('lark-channel-e2e') ||
    cmdline.includes('test-bridge');
  if (!belongs) {
    throw new PidFileError('pid file cmdline is not a test-bridge instance');
  }
}
