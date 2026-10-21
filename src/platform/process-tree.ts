import { ChildProcess, execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

/** Enough of a child for stop: a real `ChildProcess`, or a test double with `kill`. */
export interface SignalableChild {
  pid?: number;
  kill(signal: NodeJS.Signals): boolean;
}

/** Identity of a descendant that left the CLI process group. `startTicks` blocks pid reuse. */
interface ProcMark {
  pid: number;
  startTicks: number;
}

/**
 * Taken before the first signal. After the CLI exits, setsid descendants are
 * reparented and a fresh ppid walk cannot find them.
 */
const outOfGroupSnapshots = new WeakMap<SignalableChild, readonly ProcMark[]>();

/**
 * Signal a detached CLI and the processes it spawned.
 * Descendants that inherited the CLI stdout pipe are spared graceful signals
 * so the runner can drain it. SIGKILL covers the entire group after the grace.
 * On Linux, descendants that left that group (setsid / a new session) are
 * snapshotted from `/proc/<pid>/stat` ppid before the signal and signalled too.
 * The walk reads stat only, never environ or cmdline. ESRCH means the target is gone.
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

  // Snapshot before any signal so setsid children are still linked by ppid.
  const escaped = snapshotOutOfGroup(child, pid);
  const spared = signal === 'SIGKILL' ? new Set<number>() : stdoutInheritors(pid);
  let signalled = false;
  try {
    if (spared.size === 0) {
      try {
        process.kill(-pid, signal);
        signalled = true;
      } catch {
        // ESRCH: not a group leader, or the group is already gone.
        signalled = child.kill(signal);
      }
    } else {
      signalled = child.kill(signal);
      for (const member of groupMembers(pid)) {
        if (member === pid || spared.has(member)) continue;
        try {
          process.kill(member, signal);
        } catch {
          // ESRCH: that member is already gone.
        }
      }
    }
  } finally {
    signalMarks(escaped, signal);
  }
  return signalled;
}

/**
 * SIGKILL out-of-group descendants still alive after the leader has exited.
 * No-op (returns undefined) when there is nothing to wait for, so stop's fast
 * path does not gain a grace delay. Same-group members stay on the group path.
 */
export function killSurvivingOutOfGroupDescendants(
  child: SignalableChild,
  remainingGraceMs: number,
): Promise<void> | undefined {
  const marks = outOfGroupSnapshots.get(child);
  if (!marks || !marks.some(isSameLiveProcess)) return undefined;
  return waitThenKill(marks, remainingGraceMs);
}

/** Confirm detached POSIX group cleanup even after its leader/stdio have exited. */
export async function waitForProcessGroupExit(child: SignalableChild, timeoutMs: number): Promise<boolean> {
  if (process.platform === 'win32' || !child.pid || !(child instanceof ChildProcess)) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    // Zombies no longer execute or own resources; init may reap them later.
    if (groupMembers(child.pid, true).length === 0) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(20, remaining)));
  }
}

function snapshotOutOfGroup(child: SignalableChild, rootPid: number): readonly ProcMark[] {
  const existing = outOfGroupSnapshots.get(child);
  if (existing) return existing;
  const snapshot = process.platform === 'linux' ? collectOutOfGroup(rootPid) : [];
  outOfGroupSnapshots.set(child, snapshot);
  return snapshot;
}

function collectOutOfGroup(rootPid: number): ProcMark[] {
  if (rootPid === process.pid || rootPid <= 1) return [];
  const leader = readLinuxProc(rootPid);
  if (!leader) return [];
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  const marks = new Map<number, ProcMark & { pgrp: number }>();
  for (const name of names) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid || pid === rootPid || pid <= 1) continue;
    const stat = readLinuxProc(pid);
    if (!stat || stat.ppid <= 0) continue;
    marks.set(pid, { pid, startTicks: stat.startTicks, pgrp: stat.pgrp });
    const list = children.get(stat.ppid);
    if (list) list.push(pid);
    else children.set(stat.ppid, [pid]);
  }
  const out: ProcMark[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>([rootPid, process.pid]);
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid) || pid <= 1) continue;
    seen.add(pid);
    // Never walk from the bridge into unrelated processes.
    if (pid === process.pid) continue;
    const mark = marks.get(pid);
    if (!mark) continue;
    if (mark.pgrp !== leader.pgrp) out.push({ pid, startTicks: mark.startTicks });
    for (const childPid of children.get(pid) ?? []) stack.push(childPid);
  }
  return out;
}

interface LinuxProc {
  ppid: number;
  pgrp: number;
  state: string;
  startTicks: number;
}

/** `/proc/<pid>/stat` only. comm may contain spaces or parentheses; fields follow the last `)`. */
function readLinuxProc(pid: number): LinuxProc | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  const closed = text.lastIndexOf(')');
  if (closed < 0) return undefined;
  const rest = text.slice(closed + 2).trim().split(' ');
  const state = rest[0];
  const ppid = Number(rest[1]);
  const pgrp = Number(rest[2]);
  const startTicks = Number(rest[19]);
  if (!state || !Number.isInteger(ppid) || ppid < 0) return undefined;
  if (!Number.isInteger(pgrp) || pgrp < 0 || !Number.isFinite(startTicks)) return undefined;
  return { ppid, pgrp, state, startTicks };
}

function isSameLiveProcess(mark: ProcMark): boolean {
  if (mark.pid === process.pid || mark.pid <= 1) return false;
  const stat = readLinuxProc(mark.pid);
  if (!stat || stat.state === 'Z' || stat.startTicks !== mark.startTicks) return false;
  return true;
}

function signalMarks(marks: readonly ProcMark[], signal: NodeJS.Signals): void {
  for (const mark of marks) {
    if (!isSameLiveProcess(mark)) continue;
    try {
      process.kill(mark.pid, signal);
    } catch {
      // ESRCH: already gone, or EPERM for a process we must not touch.
    }
  }
}

async function waitThenKill(marks: readonly ProcMark[], remainingGraceMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, remainingGraceMs);
  while (Date.now() < deadline) {
    if (!marks.some(isSameLiveProcess)) return;
    const slice = Math.min(25, Math.max(1, deadline - Date.now()));
    await new Promise<void>(resolve => { setTimeout(resolve, slice); });
  }
  signalMarks(marks, 'SIGKILL');
  const confirmUntil = Date.now() + 500;
  while (Date.now() < confirmUntil && marks.some(isSameLiveProcess)) {
    await new Promise<void>(resolve => { setTimeout(resolve, 20); });
  }
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

function groupMembers(leaderPid: number, liveOnly = false): number[] {
  let text: string;
  try {
    text = execFileSync('ps', ['-axo', liveOnly ? 'pid=,pgid=,stat=' : 'pid=,pgid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
  } catch (error) {
    if (liveOnly) throw error; // Unknown cleanup state must not count as success.
    return [];
  }
  const members: number[] = [];
  for (const line of text.split('\n')) {
    const [pidText, pgidText, state] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const pgid = Number(pgidText);
    if (pgid === leaderPid && Number.isInteger(pid) && pid > 0 && (!liveOnly || (state && !state.startsWith('Z')))) members.push(pid);
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
