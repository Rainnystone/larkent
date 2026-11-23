import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawnProcess } from './spawn';
import { withTimeout } from './timeout';

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
  /**
   * Injectable for tests. The C# binding the holder compiles; it must declare
   * `LarkentKeepAwake` with the `SetThreadExecutionState` entry point.
   */
  typeDefinition?: string;
  acquireTimeoutMs?: number;
  releaseTimeoutMs?: number;
  /** Diagnostic sink; defaults to `console.warn`. */
  warn?: (event: string, fields: Record<string, unknown>) => void;
}

type HolderExit = { code: number | null; signal: NodeJS.Signals | null };
type Outcome = { kind: 'held' | 'timeout' } | ({ kind: 'exited' } & HolderExit);
const TIMED_OUT: Outcome = { kind: 'timeout' };

/** Printed by the holder once its request is on record. */
const HELD = 'held';

const DEFAULT_TYPE_DEFINITION = [
  'using System; using System.Runtime.InteropServices;',
  'public static class LarkentKeepAwake {',
  '[DllImport("kernel32.dll", SetLastError = true)]',
  'public static extern uint SetThreadExecutionState(uint esFlags); }',
].join(' ');

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
//
// PowerShell runs on past a failed statement inside a `-Command` string, so
// the binding, the request and the confirmation share one guarded block:
// `held` is unreachable unless the request was really made. The .NET calls are
// assigned rather than piped, because piping one marks the statement as failed
// and would turn a clean exit into exit code 1.
function holderScript(typeDefinition: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `$sig = '${typeDefinition.replace(/'/g, "''")}'`,
    'Add-Type -TypeDefinition $sig',
    '$held = [uint32]2147483649',
    'if ([LarkentKeepAwake]::SetThreadExecutionState($held) -eq 0) { exit 1 }',
    '} catch { [Console]::Error.WriteLine($_); exit 1 }',
    `[Console]::Out.WriteLine('${HELD}')`,
    '$null = [Console]::In.ReadToEnd()',
    '$null = [LarkentKeepAwake]::SetThreadExecutionState([uint32]2147483648)',
    'exit 0',
  ].join('; ');
}

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
  const holderArgs = ['-NoProfile', '-NonInteractive', '-Command', holderScript(opts.typeDefinition ?? DEFAULT_TYPE_DEFINITION)] as const;
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? KEEP_AWAKE_ACQUIRE_TIMEOUT_MS;
  const releaseTimeoutMs = opts.releaseTimeoutMs ?? KEEP_AWAKE_RELEASE_TIMEOUT_MS;
  return {
    async acquire() {
      let child: ChildProcess;
      try {
        child = spawnFn(powershellPath, holderArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        warn('holder-not-started', { reason: 'spawn-error', err: String(err) });
        return undefined;
      }
      // A holder that died an instant ago fails the next stdin write. That
      // surfaces as an 'error' on the stream, which throws when nobody listens.
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => {});
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
      const outcome = await withTimeout(
        Promise.race([heldOutcome(child), exited.then((exit): Outcome => ({ kind: 'exited', ...exit }))]),
        acquireTimeoutMs,
        TIMED_OUT,
      );
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
          if (await withTimeout(exited.then(() => true), releaseTimeoutMs, false)) return;
          child.kill();
        },
      };
    },
  };
}

/** The holder's first `held` on stdout. Settles only on that. */
function heldOutcome(child: ChildProcess): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    let seen = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      seen += chunk;
      if (seen.includes(HELD)) resolve({ kind: 'held' });
    });
  });
}

function defaultPowerShellPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
