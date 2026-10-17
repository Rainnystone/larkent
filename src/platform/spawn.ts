import { existsSync } from 'node:fs';
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
  type SpawnSyncOptions,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import crossSpawn from 'cross-spawn';

/**
 * Turn journal reaps agent CLI orphans. The JSONL runner passes
 * `detached: true` so a supervise.sh / Ctrl-C group signal does not kill an
 * in-flight CLI, and a SIGKILL of the bridge leaves a child the journal can
 * match by pid + start time. Other `spawnProcess` callers keep the default
 * (same group) unless they opt in.
 */
export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  if (missingWindowsPathSkipsCmdWrap(command, options.shell)) {
    return nodeSpawn(command, [...args], options);
  }
  return crossSpawn(command, [...args], options);
}

export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
) {
  if (missingWindowsPathSkipsCmdWrap(command, options.shell)) {
    return nodeSpawnSync(command, [...args], options);
  }
  return crossSpawn.sync(command, [...args], options);
}

/**
 * cross-spawn on Windows wraps anything that is not `*.exe`/`*.com` with
 * `cmd.exe /d /s /c` — including a path that does not exist
 * (`needsShell = !/\.(?:com|exe)$/i.test(undefined)`). That assigns a pid
 * and can exit 0 before "not recognized" stderr is classified, so a missing
 * JSONL CLI looks like a clean empty success. Spawn the missing path with
 * Node instead so it surfaces ENOENT.
 */
function missingWindowsPathSkipsCmdWrap(command: string, shell: boolean | string | undefined): boolean {
  if (process.platform !== 'win32' || shell) return false;
  if (!/[\\/]/.test(command) || /\.(?:exe|com|cmd|bat)$/i.test(command)) return false;
  try {
    return !existsSync(command);
  } catch {
    return false;
  }
}

export function mergeProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        delete out[existing];
      }
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export type SpawnedProcessByStdio<
  Stdin extends Writable | null,
  Stdout extends Readable | null,
  Stderr extends Readable | null,
> = ChildProcessByStdio<Stdin, Stdout, Stderr>;
