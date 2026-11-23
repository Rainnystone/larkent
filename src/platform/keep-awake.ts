import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawnProcess } from './spawn';

/** The holder has this long to confirm it owns the request. */
export const KEEP_AWAKE_ACQUIRE_TIMEOUT_MS = 15_000;
/** A released holder exits at once; past this it is killed. */
export const KEEP_AWAKE_RELEASE_TIMEOUT_MS = 5_000;

export interface KeepAwakeHandle {
  /** Stops holding. Best effort: never throws, safe to call more than once. */
  release(): Promise<void>;
}

export interface KeepAwake {
  /**
   * Ask the OS to keep the system awake until the handle is released.
   * Resolves undefined when this host has no holder or the holder failed to
   * start; never throws. The request is advisory: an explicit sleep, the
   * power button or a lid-close action still puts the host to sleep.
   */
  acquire(): Promise<KeepAwakeHandle | undefined>;
}

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  /** Injectable for tests. Defaults to {@link spawnProcess}. */
  spawn?: typeof spawnProcess;
  /** Injectable for tests. Defaults to Windows PowerShell under `%SystemRoot%`. */
  powershellPath?: string;
  acquireTimeoutMs?: number;
  releaseTimeoutMs?: number;
  /** Diagnostic sink; defaults to `console.warn`. */
  warn?: (event: string, fields: Record<string, unknown>) => void;
}

type HolderExit = { code: number | null; signal: NodeJS.Signals | null };
type Outcome = { kind: 'held' } | ({ kind: 'exited' } & HolderExit) | { kind: 'timeout' };

/** Printed by the holder once its request is on record. */
const HELD = 'held';

// `SetThreadExecutionState` is a Win32 call with no PowerShell wrapper, so the
// holder compiles a one-line binding with Add-Type. The script travels inline
// in `-Command`: execution policy only governs script files, so a locked-down
// host is not blocked by it.
//
// The request is ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1). It
// belongs to the holder's thread, so it ends when that thread clears it or
// exits. The holder parks on stdin and leaves on EOF, which is how release
// reaches it; a bridge that dies without releasing closes the pipe just the
// same.
const HOLDER_SCRIPT = [
  "$sig = 'using System; using System.Runtime.InteropServices;",
  'public static class LarkentKeepAwake {',
  '[DllImport("kernel32.dll", SetLastError = true)]',
  "public static extern uint SetThreadExecutionState(uint esFlags); }'",
  'Add-Type -TypeDefinition $sig',
  '$held = [uint32]2147483649',
  'if ([LarkentKeepAwake]::SetThreadExecutionState($held) -eq 0) { exit 1 }',
  `[Console]::Out.WriteLine('${HELD}')`,
  '[Console]::In.ReadToEnd() | Out-Null',
  '[LarkentKeepAwake]::SetThreadExecutionState([uint32]2147483648) | Out-Null',
].join('; ');

const HOLDER_ARGS = ['-NoProfile', '-NonInteractive', '-Command', HOLDER_SCRIPT] as const;

export function createKeepAwake(opts: KeepAwakeOptions = {}): KeepAwake {
  const platform = opts.platform ?? process.platform;
  const warn = opts.warn ?? ((event, fields) => console.warn('[keep-awake]', event, fields));
  if (platform !== 'win32') {
    return {
      async acquire() {
        warn('unsupported-platform', { platform });
        return undefined;
      },
    };
  }
  const spawnFn = opts.spawn ?? spawnProcess;
  const powershellPath = opts.powershellPath ?? defaultPowerShellPath();
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? KEEP_AWAKE_ACQUIRE_TIMEOUT_MS;
  const releaseTimeoutMs = opts.releaseTimeoutMs ?? KEEP_AWAKE_RELEASE_TIMEOUT_MS;
  return {
    async acquire() {
      let child: ChildProcess;
      try {
        child = spawnFn(powershellPath, HOLDER_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        warn('holder-not-started', { reason: 'spawn-error', err: String(err) });
        return undefined;
      }
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk}`.slice(-2_000);
      });
      // An async spawn failure throws out of the 'error' event unless someone listens.
      child.on('error', () => {});
      // Spawn failures raise 'error' and may never raise 'exit'.
      const exited = new Promise<HolderExit>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
        child.once('error', () => resolve({ code: null, signal: null }));
      });
      const outcome = await confirmHeld(child, exited, acquireTimeoutMs);
      if (outcome.kind !== 'held') {
        // stderr usually lands a tick after the exit event.
        await new Promise<void>((resolve) => setImmediate(resolve));
        warn('holder-not-started', { reason: outcome.kind, ...(outcome.kind === 'exited' ? outcome : {}), stderr: stderr.trim() });
        child.kill();
        return undefined;
      }
      let released = false;
      let gone = false;
      child.once('exit', (code, signal) => {
        gone = true;
        if (released) return;
        released = true;
        warn('holder-exited', { code, signal });
      });
      return {
        async release() {
          if (released) return;
          released = true;
          if (!gone && !child.stdin?.destroyed) child.stdin?.end();
          if (await settlesWithin(exited, releaseTimeoutMs)) return;
          child.kill();
        },
      };
    },
  };
}

async function confirmHeld(
  child: ChildProcess,
  exited: Promise<HolderExit>,
  timeoutMs: number,
): Promise<Outcome> {
  const held = new Promise<Outcome>((resolve) => {
    let seen = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      seen += chunk;
      if (seen.includes(HELD)) resolve({ kind: 'held' });
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      held,
      exited.then((exit): Outcome => ({ kind: 'exited', ...exit })),
      new Promise<Outcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function settlesWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function defaultPowerShellPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
