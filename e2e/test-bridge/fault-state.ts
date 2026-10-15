import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FAULT_MODES = [
  'cursor-stall',
  'cursor-auth',
  'agy-print-timeout',
  'agy-interrupted',
  'hang',
] as const;

export type NamedFaultMode = (typeof FAULT_MODES)[number];

export type ParsedFaultMode = NamedFaultMode | { type: 'delay'; seconds: number };

export interface ArmedFault {
  mode: string;
  runId?: string;
  sticky?: boolean;
  used?: boolean;
}

export interface FaultFile {
  faults: ArmedFault[];
}

export function stripStickySuffix(raw: string): { mode: string; sticky: boolean } {
  if (raw.endsWith(':sticky')) {
    return { mode: raw.slice(0, -':sticky'.length), sticky: true };
  }
  return { mode: raw, sticky: false };
}

export function parseFaultMode(raw: string): ParsedFaultMode {
  const { mode } = stripStickySuffix(raw);
  const delay = /^delay:(\d+(?:\.\d+)?)$/.exec(mode);
  if (delay) {
    return { type: 'delay', seconds: Number(delay[1]) };
  }
  if ((FAULT_MODES as readonly string[]).includes(mode)) {
    return mode as NamedFaultMode;
  }
  throw new Error(`unknown fault mode: ${raw}`);
}

export async function readFaultFile(faultDir: string): Promise<FaultFile> {
  try {
    const parsed = JSON.parse(await readFile(join(faultDir, 'faults.json'), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || !('faults' in parsed)) return { faults: [] };
    const faults = (parsed as FaultFile).faults;
    return { faults: Array.isArray(faults) ? faults : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { faults: [] };
    throw err;
  }
}

export async function writeFaultFile(faultDir: string, file: FaultFile): Promise<void> {
  await mkdir(faultDir, { recursive: true });
  await writeFile(join(faultDir, 'faults.json'), `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function armFault(
  faultDir: string,
  fault: { mode: string; runId?: string; sticky?: boolean },
): Promise<void> {
  const parsed = stripStickySuffix(fault.mode);
  parseFaultMode(parsed.mode);
  const current = await readFaultFile(faultDir);
  current.faults.push({
    mode: parsed.mode,
    ...(fault.runId ? { runId: fault.runId } : {}),
    ...(fault.sticky || parsed.sticky ? { sticky: true } : {}),
    used: false,
  });
  await writeFaultFile(faultDir, current);
}

export async function clearFaults(faultDir: string): Promise<void> {
  await writeFaultFile(faultDir, { faults: [] });
}

export async function nextInvocationId(faultDir: string): Promise<string> {
  await mkdir(faultDir, { recursive: true });
  const path = join(faultDir, 'invocations.json');
  let next = 1;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { next?: unknown };
    if (typeof parsed.next === 'number' && Number.isFinite(parsed.next) && parsed.next >= 1) {
      next = Math.floor(parsed.next);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await writeFile(path, `${JSON.stringify({ next: next + 1 })}\n`, { mode: 0o600 });
  return String(next);
}

export function matchFault(file: FaultFile, runId: string): ArmedFault | undefined {
  return file.faults.find((fault) => {
    if (fault.used && !fault.sticky) return false;
    if (fault.runId && fault.runId !== runId) return false;
    return true;
  });
}

export async function consumeFault(faultDir: string, runId: string): Promise<ArmedFault | undefined> {
  const file = await readFaultFile(faultDir);
  const hit = matchFault(file, runId);
  if (!hit) return undefined;
  if (!hit.sticky) hit.used = true;
  await writeFaultFile(faultDir, file);
  return hit;
}
