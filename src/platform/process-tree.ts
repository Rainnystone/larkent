import { ChildProcess, execFileSync, spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';

/** Enough of a child for stop: a real `ChildProcess`, or a test double with `kill`. */
export interface SignalableChild {
  pid?: number;
  kill(signal: NodeJS.Signals): boolean;
}

/**
 * Signal a detached CLI and the processes it spawned.
 * Descendants that inherited the CLI stdout pipe are spared graceful signals
 * so the runner can drain it. SIGKILL covers the entire group after the grace.
 * ESRCH from a group or member signal means that target is already gone.
 * Windows has no negative-pid process groups; `taskkill /T` is the tree.
 */
export function signalProcessTree(
  child: SignalableChild,
  signal: NodeJS.Signals,
  detached: boolean,
): boolean {
  const pid = child.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0 || !(child instanceof ChildProcess)) {
    return child.kill(signal);
  }
  if (process.platform === 'win32') {
    if (killWindowsTree(pid)) return true;
    return child.kill(signal);
  }
  if (!detached) return child.kill(signal);

  const spared = signal === 'SIGKILL' ? new Set<number>() : stdoutInheritors(pid);
  if (spared.size === 0) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // ESRCH: not a group leader, or the group is already gone.
      return child.kill(signal);
    }
  }

  const signalled = child.kill(signal);
  for (const member of groupMembers(pid)) {
    if (member === pid || spared.has(member)) continue;
    try {
      process.kill(member, signal);
    } catch {
      // ESRCH: that member is already gone.
    }
  }
  return signalled;
}

function killWindowsTree(pid: number): boolean {
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Other group members whose fd 1 is the leader's stdout pipe. */
function stdoutInheritors(leaderPid: number): Set<number> {
  const identity = fd1Identity(leaderPid);
  const spared = new Set<number>();
  if (!identity) return spared;
  for (const member of groupMembers(leaderPid)) {
    if (member === leaderPid) continue;
    if (fd1Identity(member) === identity) spared.add(member);
  }
  return spared;
}

function groupMembers(leaderPid: number): number[] {
  let text: string;
  try {
    text = execFileSync('ps', ['-axo', 'pid=,pgid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
  } catch {
    return [];
  }
  const members: number[] = [];
  for (const line of text.split('\n')) {
    const [pidText, pgidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const pgid = Number(pgidText);
    if (pgid === leaderPid && Number.isInteger(pid) && pid > 0) members.push(pid);
  }
  return members;
}

function fd1Identity(pid: number): string | undefined {
  const identity = process.platform === 'darwin' ? darwinFd1(pid) : linuxFd1(pid);
  if (!identity || identity === '/dev/null' || identity === 'NUL') return undefined;
  return identity;
}

function linuxFd1(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/fd/1`);
  } catch {
    return undefined;
  }
}

function darwinFd1(pid: number): string | undefined {
  let text: string;
  try {
    text = execFileSync('lsof', ['-n', '-P', '-a', '-p', String(pid), '-d', '1', '-F', 'nDti'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  } catch {
    return undefined;
  }
  const fields: string[] = [];
  for (const line of text.split('\n')) {
    const kind = line[0];
    if (kind === 'n' || kind === 'D' || kind === 't' || kind === 'i') fields.push(line);
  }
  return fields.length > 0 ? fields.join('\n') : undefined;
}
