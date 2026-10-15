import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const START_TIME_SKEW_MS = 5_000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Wall-clock start time of `pid`, or undefined when the OS will not tell us. */
export function readProcessStartMs(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') return linuxStartMs(pid);
  if (process.platform === 'darwin') return darwinStartMs(pid);
  return undefined;
}

export function processMatchesIdentity(
  pid: number,
  startedAt: number | undefined,
  opts: {
    isAlive?: (pid: number) => boolean;
    processStartMs?: (pid: number) => number | undefined;
    skewMs?: number;
  } = {},
): boolean {
  const alive = opts.isAlive ?? isProcessAlive;
  if (!alive(pid)) return false;
  if (startedAt === undefined) return true;
  const readStart = opts.processStartMs ?? readProcessStartMs;
  const actual = readStart(pid);
  if (actual === undefined) return true;
  return Math.abs(actual - startedAt) <= (opts.skewMs ?? START_TIME_SKEW_MS);
}

function linuxStartMs(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closed = stat.lastIndexOf(')');
    if (closed === -1) return undefined;
    const rest = stat.slice(closed + 2).trim().split(' ');
    const startTicks = Number(rest[19]);
    if (!Number.isFinite(startTicks)) return undefined;
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
    if (!Number.isFinite(btime)) return undefined;
    return (btime + startTicks / clkTck()) * 1000;
  } catch {
    return undefined;
  }
}

function darwinStartMs(pid: number): number | undefined {
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!text) return undefined;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

function clkTck(): number {
  try {
    const raw = execFileSync('getconf', ['CLK_TCK'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 100;
  } catch {
    return 100;
  }
}
