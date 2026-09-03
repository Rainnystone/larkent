import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { log } from '../../core/logger';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import type { AgentEvent, AgentRun } from '../types';

export type JsonlFinishReason = 'normal' | 'interrupted' | 'timeout';

export interface JsonlTranslator {
  translate(line: string): Iterable<AgentEvent>;
  finish(reason?: JsonlFinishReason): Iterable<AgentEvent>;
  fail(error: unknown): Iterable<AgentEvent>;
  terminalEmitted?(): boolean;
}

export interface ParsedJsonlTranslator {
  translate(parsed: unknown): Iterable<AgentEvent>;
  finish?(reason?: string): Iterable<AgentEvent>;
  fail?(message: string): Iterable<AgentEvent>;
  terminalEmitted?(): boolean;
}

export interface JsonlCliRunnerInput {
  runId: string;
  binaryPath: string;
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  translator: JsonlTranslator;
  cleanup?: () => void | Promise<void>;
  signal?: AbortSignal;
  timeouts?: { idleMs?: number; totalMs?: number };
  stopGraceMs?: number;
  spawnName: string;
  emptyStdoutDestroyMs?: number;
  missingTerminalOnSuccess?: string;
  failNonzeroAfterTerminal?: boolean;
  successFinish?: JsonlFinishReason;
  logFields?: Record<string, unknown>;
}

type CliChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export function wrapParsedTranslator(
  inner: ParsedJsonlTranslator,
  spawnName: string,
): JsonlTranslator {
  return {
    translate(line: string): AgentEvent[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      return [...inner.translate(parsed)];
    },
    finish(reason?: JsonlFinishReason): AgentEvent[] {
      return inner.finish ? [...inner.finish(reason)] : [];
    },
    fail(error: unknown): AgentEvent[] {
      const message = failMessage(spawnName, error);
      if (inner.fail) return [...inner.fail(message)];
      return [{ type: 'error', message, terminationReason: 'failed' }];
    },
    terminalEmitted: inner.terminalEmitted?.bind(inner),
  };
}

export function runJsonlCli(input: JsonlCliRunnerInput): AgentRun {
  const stopGraceMs = input.stopGraceMs ?? 5000;
  const child = spawnProcess(input.binaryPath, [...input.argv], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CliChild;

  log.info('agent', 'spawn', {
    pid: child.pid ?? null,
    cwd: input.cwd,
    promptChars: typeof input.stdin === 'string' ? input.stdin.length : undefined,
    ...input.logFields,
  });

  const stdoutLines: string[] = [];
  let stdoutClosed = false;
  let stdoutNotify: (() => void) | undefined;
  const onStdoutSettled = (): void => {
    const notify = stdoutNotify;
    stdoutNotify = undefined;
    notify?.();
  };
  const stdoutDecoder = new StringDecoder('utf8');
  let stdoutBuffer = '';
  let sawStdout = false;

  const stderrChunks: Buffer[] = [];
  let runtimeError: Error | null = null;
  let stderrBuffer = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrBuffer += chunk.toString('utf8');
    let nl = stderrBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stderrBuffer.slice(0, nl);
      stderrBuffer = stderrBuffer.slice(nl + 1);
      if (line.trim()) log.warn('agent', 'stderr', { line });
      if (isWindowsCommandNotFoundLine(line)) {
        runtimeError = new Error(`failed to spawn ${input.spawnName}: ${line.trim()}`);
        child.stdout.destroy();
        child.kill();
      }
      nl = stderrBuffer.indexOf('\n');
    }
  });

  let stopReason: JsonlFinishReason | undefined;
  let abortHandler: (() => void) | undefined;
  const detachAbort = (): void => {
    if (!abortHandler || !input.signal) return;
    input.signal.removeEventListener('abort', abortHandler);
    abortHandler = undefined;
  };

  let cleanupPromise: Promise<void> | undefined;
  const runCleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await waitForExitCode(child);
      }
      detachAbort();
      await input.cleanup?.();
    })();
    return cleanupPromise;
  };
  const scheduleCleanup = (): void => {
    void runCleanup().catch(() => {});
  };

  let stopInFlight: Promise<void> | undefined;
  const stopChild = (reason: JsonlFinishReason): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    if (stopInFlight) return stopInFlight;
    stopReason = reason;
    stopInFlight = new Promise<void>((resolve) => {
      log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          log.warn('agent', 'stop-sigkill', {
            pid: child.pid ?? null,
            graceMs: stopGraceMs,
            reason: 'grace-period-expired',
          });
          child.kill('SIGKILL');
        }
        resolve();
      }, stopGraceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return stopInFlight;
  };

  const idleMs = input.timeouts?.idleMs;
  const totalMs = input.timeouts?.totalMs;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    if (!idleMs || idleMs === Number.POSITIVE_INFINITY) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void stopChild('timeout');
    }, idleMs);
  };
  if (totalMs && totalMs !== Number.POSITIVE_INFINITY) {
    totalTimer = setTimeout(() => {
      void stopChild('timeout');
    }, totalMs);
  }
  armIdle();

  const enqueueStdoutLine = (line: string): void => {
    if (!line) return;
    stdoutLines.push(line);
    armIdle();
  };

  child.stdout.on('data', (chunk: Buffer) => {
    sawStdout = true;
    stdoutBuffer += stdoutDecoder.write(chunk);
    let nl = stdoutBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stdoutBuffer.slice(0, nl).trim();
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      enqueueStdoutLine(line);
      nl = stdoutBuffer.indexOf('\n');
      onStdoutSettled();
    }
  });
  const closeStdout = (): void => {
    if (stdoutClosed) return;
    stdoutClosed = true;
    stdoutBuffer += stdoutDecoder.end();
    const tail = stdoutBuffer.trim();
    stdoutBuffer = '';
    enqueueStdoutLine(tail);
    onStdoutSettled();
  };
  child.stdout.on('end', closeStdout);
  child.stdout.on('close', closeStdout);

  child.on('error', (err) => {
    runtimeError = err;
    closeStdout();
    scheduleCleanup();
  });
  child.on('exit', (code, signal) => {
    log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    scheduleCleanup();
  });
  child.stdin.on('error', (err) => {
    log.warn('agent', 'stdin-error', { message: err.message });
  });
  if (typeof input.stdin === 'string') {
    child.stdin.end(input.stdin, 'utf8');
  } else {
    child.stdin.end();
  }

  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  if (input.emptyStdoutDestroyMs && input.emptyStdoutDestroyMs > 0) {
    const closeSilentStdout = (): void => {
      silentExitTimer = setTimeout(() => {
        if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
      }, input.emptyStdoutDestroyMs);
    };
    child.once('exit', closeSilentStdout);
  }

  const stdout = {
    nextLine(): string | undefined {
      return stdoutLines.shift();
    },
    closed(): boolean {
      return stdoutClosed;
    },
    wait(): Promise<void> {
      return new Promise<void>((resolve) => {
        stdoutNotify = resolve;
      });
    },
  };

  if (input.signal) {
    if (input.signal.aborted) {
      void stopChild('interrupted');
    } else {
      abortHandler = () => {
        void stopChild('interrupted');
      };
      input.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    if (silentExitTimer) clearTimeout(silentExitTimer);
  };

  return {
    runId: input.runId,
    events: iterateEvents({
      child,
      stdout,
      stderrChunks,
      translator: input.translator,
      spawnName: input.spawnName,
      getError: () => runtimeError,
      getStopReason: () => stopReason,
      missingTerminalOnSuccess: input.missingTerminalOnSuccess,
      failNonzeroAfterTerminal: input.failNonzeroAfterTerminal === true,
      successFinish: input.successFinish,
      cleanup: async () => {
        clearTimers();
        detachAbort();
        await runCleanup();
      },
    }),
    async stop() {
      await stopChild('interrupted');
    },
    waitForExit(timeoutMs: number): Promise<boolean> {
      if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const onExit = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          child.removeListener('exit', onExit);
          resolve(false);
        }, timeoutMs);
        child.once('exit', onExit);
      });
    },
  };
}

async function* iterateEvents(input: {
  child: CliChild;
  stdout: {
    nextLine(): string | undefined;
    closed(): boolean;
    wait(): Promise<void>;
  };
  stderrChunks: Buffer[];
  translator: JsonlTranslator;
  spawnName: string;
  getError: () => Error | null;
  getStopReason: () => JsonlFinishReason | undefined;
  missingTerminalOnSuccess?: string;
  failNonzeroAfterTerminal: boolean;
  successFinish?: JsonlFinishReason;
  cleanup: () => Promise<void>;
}): AsyncGenerator<AgentEvent> {
  try {
    if (!input.child.pid) {
      const err = input.getError();
      yield {
        type: 'error',
        message: err ? `failed to spawn ${input.spawnName}: ${err.message}` : 'spawn returned no pid',
        terminationReason: 'failed',
      };
      return;
    }

    for (;;) {
      let line = input.stdout.nextLine();
      while (line !== undefined) {
        yield* input.translator.translate(line);
        line = input.stdout.nextLine();
      }
      if (input.stdout.closed()) break;
      await input.stdout.wait();
    }

    const earlyRuntimeError = input.getError();
    if (earlyRuntimeError && input.child.exitCode === null && input.child.signalCode === null) {
      yield* input.translator.fail(`${input.spawnName} runtime error: ${earlyRuntimeError.message}`);
      return;
    }

    const exitCode = await waitForExitCode(input.child);
    const stopReason = input.getStopReason();
    if (stopReason === 'interrupted' || stopReason === 'timeout') {
      if (stopReason === 'timeout' && !input.translator.terminalEmitted?.()) {
        yield {
          type: 'error',
          message: `${input.spawnName} ${stopReason}`,
          terminationReason: 'timeout',
        };
        return;
      }
      yield* input.translator.finish(stopReason);
      return;
    }

    const runtimeError = input.getError();
    const terminal = input.translator.terminalEmitted?.() === true;
    if (exitCode !== 0 && exitCode !== null) {
      if (!terminal || input.failNonzeroAfterTerminal) {
        const stderr = Buffer.concat(input.stderrChunks).toString('utf8').trim();
        const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
        yield* input.translator.fail(`${input.spawnName} exited with code ${exitCode}${detail}`);
      }
      return;
    }
    if (runtimeError && !terminal) {
      yield* input.translator.fail(`${input.spawnName} runtime error: ${runtimeError.message}`);
      return;
    }
    if (input.missingTerminalOnSuccess && !terminal) {
      yield* input.translator.fail(input.missingTerminalOnSuccess);
      return;
    }
    yield* input.translator.finish(input.successFinish);
  } finally {
    await input.cleanup();
  }
}

async function waitForExitCode(child: CliChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    const onExit = (code: number | null): void => {
      resolve(code);
    };
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.removeListener('exit', onExit);
      resolve(child.exitCode);
    }
  });
}

function failMessage(spawnName: string, error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return `${spawnName} failed`;
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
