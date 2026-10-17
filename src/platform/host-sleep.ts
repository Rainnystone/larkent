import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Wall-clock tick gap that still takes the link down; not itself suspend evidence. */
export const HOST_SLEEP_MIN_MS = 1_000;
export const HOST_SLEEP_PROBE_TIMEOUT_MS = 1_000;

export interface HostSleepGap {
  fromMs: number;
  toMs: number;
}

export interface HostSleepEvidence {
  suspended: boolean;
  suspendStartedAt?: number;
}

export interface HostSleepProbe {
  /** Snapshot OS clocks. Called on every tick; must not throw. */
  note(atMs: number): void | Promise<void>;
  /**
   * Real OS sleep inside the gap? Own timeout. Failure/timeout = not suspended.
   * Never throws.
   */
  detect(gap: HostSleepGap): Promise<HostSleepEvidence>;
}

export interface HostSleepProbeOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  readUptime?: () => Promise<string>;
  hrtime?: () => bigint;
  sysctl?: (key: string) => Promise<string>;
  queryKernelPower?: (gap: HostSleepGap) => Promise<string>;
}

interface LinuxSample {
  atMs: number;
  uptimeSec: number;
  monoNs: bigint;
}

const notSuspended: HostSleepEvidence = { suspended: false };

export function createHostSleepProbe(opts: HostSleepProbeOptions = {}): HostSleepProbe {
  const platform = opts.platform ?? process.platform;
  switch (platform) {
    case 'linux':
      return createLinuxProbe(opts);
    case 'darwin':
      return createDarwinProbe(opts);
    case 'win32':
      return createWindowsProbe(opts);
    default:
      return {
        note() {},
        async detect() {
          return notSuspended;
        },
      };
  }
}

export function parseProcUptime(text: string): number | undefined {
  const first = text.trim().split(/\s+/)[0];
  if (first === undefined) return undefined;
  const n = Number(first);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function linuxSleepMs(
  prev: { uptimeSec: number; monoNs: bigint },
  next: { uptimeSec: number; monoNs: bigint },
): number {
  const bootMs = (next.uptimeSec - prev.uptimeSec) * 1000;
  const monoMs = Number(next.monoNs - prev.monoNs) / 1e6;
  if (!Number.isFinite(bootMs) || !Number.isFinite(monoMs)) return 0;
  return Math.max(0, Math.round(bootMs - monoMs));
}

export function parseSysctlTime(text: string): number | undefined {
  const sec = /sec\s*=\s*(-?\d+)/.exec(text);
  if (sec) {
    const n = Number(sec[1]);
    if (Number.isFinite(n) && n > 0) return n * 1000;
  }
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function darwinSleepEvidence(input: {
  sleepMs?: number;
  wakeMs?: number;
  gap: HostSleepGap;
}): HostSleepEvidence {
  const inGap = (at: number | undefined): boolean => (
    at !== undefined && at > input.gap.fromMs && at <= input.gap.toMs
  );
  if (!inGap(input.wakeMs) && !inGap(input.sleepMs)) return notSuspended;
  return {
    suspended: true,
    ...(input.sleepMs !== undefined ? { suspendStartedAt: input.sleepMs } : {}),
  };
}

export function parseWindowsKernelPower(xml: string): Array<{ atMs: number; eventId: number }> {
  const events: Array<{ atMs: number; eventId: number }> = [];
  const blocks = xml.split(/<Event\b/i).slice(1);
  for (const block of blocks) {
    const id = Number(/<EventID[^>]*>\s*(\d+)\s*<\/EventID>/i.exec(block)?.[1]);
    const stamp = /TimeCreated\s+SystemTime="([^"]+)"/i.exec(block)?.[1];
    if (!Number.isFinite(id) || !stamp) continue;
    const atMs = Date.parse(stamp);
    if (!Number.isFinite(atMs)) continue;
    events.push({ atMs, eventId: id });
  }
  return events;
}

export function windowsSleepEvidence(input: {
  events: Array<{ atMs: number; eventId: number }>;
  gap: HostSleepGap;
}): HostSleepEvidence {
  const inGap = input.events
    .filter((event) => event.atMs > input.gap.fromMs && event.atMs <= input.gap.toMs)
    .filter((event) => event.eventId === 42 || event.eventId === 107 || event.eventId === 1)
    .sort((a, b) => a.atMs - b.atMs || a.eventId - b.eventId);
  const first = inGap[0];
  if (!first) return notSuspended;
  const sleep = inGap.find((event) => event.eventId === 42) ?? first;
  return { suspended: true, suspendStartedAt: sleep.atMs };
}

function createLinuxProbe(opts: HostSleepProbeOptions): HostSleepProbe {
  const timeoutMs = opts.timeoutMs ?? HOST_SLEEP_PROBE_TIMEOUT_MS;
  const readUptime = opts.readUptime ?? defaultReadUptime;
  const hrtime = opts.hrtime ?? (() => process.hrtime.bigint());
  let prev: LinuxSample | undefined;

  const sample = async (atMs: number): Promise<LinuxSample | undefined> => {
    const uptimeSec = parseProcUptime(await readUptime());
    if (uptimeSec === undefined) return undefined;
    return { atMs, uptimeSec, monoNs: hrtime() };
  };

  return {
    async note(atMs) {
      try {
        const taken = await withTimeout(sample(atMs), timeoutMs, undefined);
        if (taken) prev = taken;
      } catch {
        /* keep the previous sample */
      }
    },
    async detect(gap) {
      try {
        const before = prev;
        const next = await withTimeout(sample(gap.toMs), timeoutMs, undefined);
        if (!before || !next) return notSuspended;
        const sleptMs = linuxSleepMs(before, next);
        if (sleptMs < HOST_SLEEP_MIN_MS) return notSuspended;
        return {
          suspended: true,
          suspendStartedAt: gap.toMs - sleptMs,
        };
      } catch {
        return notSuspended;
      }
    },
  };
}

/** macOS: kern.waketime / kern.sleeptime. Node 20 hrtime is mach_continuous_time and advances during sleep. */
function createDarwinProbe(opts: HostSleepProbeOptions): HostSleepProbe {
  const timeoutMs = opts.timeoutMs ?? HOST_SLEEP_PROBE_TIMEOUT_MS;
  const sysctl = opts.sysctl ?? defaultSysctl;
  return {
    note() {},
    async detect(gap) {
      try {
        const [sleepText, wakeText] = await withTimeout(
          Promise.all([sysctl('kern.sleeptime'), sysctl('kern.waketime')]),
          timeoutMs,
          undefined,
        ) ?? [undefined, undefined];
        if (sleepText === undefined && wakeText === undefined) return notSuspended;
        return darwinSleepEvidence({
          sleepMs: sleepText !== undefined ? parseSysctlTime(sleepText) : undefined,
          wakeMs: wakeText !== undefined ? parseSysctlTime(wakeText) : undefined,
          gap,
        });
      } catch {
        return notSuspended;
      }
    },
  };
}

function createWindowsProbe(opts: HostSleepProbeOptions): HostSleepProbe {
  const timeoutMs = opts.timeoutMs ?? HOST_SLEEP_PROBE_TIMEOUT_MS;
  const query = opts.queryKernelPower ?? defaultQueryKernelPower;
  return {
    note() {},
    async detect(gap) {
      try {
        const xml = await withTimeout(query(gap), timeoutMs, undefined);
        if (xml === undefined) return notSuspended;
        return windowsSleepEvidence({
          events: parseWindowsKernelPower(xml),
          gap,
        });
      } catch {
        return notSuspended;
      }
    },
  };
}

async function defaultReadUptime(): Promise<string> {
  return await readFile('/proc/uptime', 'utf8');
}

async function defaultSysctl(key: string): Promise<string> {
  const { stdout } = await execFileAsync('sysctl', ['-n', key], {
    timeout: HOST_SLEEP_PROBE_TIMEOUT_MS,
    encoding: 'utf8',
  });
  return stdout;
}

async function defaultQueryKernelPower(gap: HostSleepGap): Promise<string> {
  const from = new Date(gap.fromMs).toISOString();
  const to = new Date(gap.toMs).toISOString();
  const query = [
    '*[System[Provider[@Name=\'Microsoft-Windows-Kernel-Power\']',
    ` and (EventID=42 or EventID=107 or EventID=1)`,
    ` and TimeCreated[@SystemTime>='${from}' and @SystemTime<='${to}']]]`,
  ].join('');
  const { stdout } = await execFileAsync(
    'wevtutil',
    ['qe', 'System', `/q:${query}`, '/f:xml', '/c:20'],
    { timeout: HOST_SLEEP_PROBE_TIMEOUT_MS, encoding: 'utf8' },
  );
  return stdout;
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  );
  try {
    const winner = await Promise.race([
      settled,
      new Promise<{ ok: false }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return winner.ok ? winner.value : fallback;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
