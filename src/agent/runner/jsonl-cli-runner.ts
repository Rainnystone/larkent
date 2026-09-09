import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { log } from '../../core/logger';
import { RunCleanupFailed } from '../../runtime/errors';
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

const STOP_STDOUT_QUIET_MS = 50;
const STOP_STDOUT_DRAIN_MS = 5000;

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

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    if (silentExitTimer) clearTimeout(silentExitTimer);
  };

  let exited = false;
  let resolveExit!: (code: number | null) => void;
  const exitPromise = new Promise<number | null>(resolve => { resolveExit = resolve; });
  let rejectEventExit!: (error: unknown) => void;
  const eventExit = Promise.race([
    exitPromise,
    new Promise<never>((_resolve, reject) => { rejectEventExit = reject; }),
  ]);
  void eventExit.catch(() => {});
  const confirmExit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    clearTimers();
    detachAbort();
    resolveExit(code);
  };
  let cleanupPromise: Promise<void> | undefined;
  const runCleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      await exitPromise;
      try {
        const cleaned = await within(Promise.resolve().then(() => input.cleanup?.()), 5000);
        if (cleaned === false) throw new RunCleanupFailed('adapter cleanup timed out');
      } catch (error) {
        if (error instanceof RunCleanupFailed) throw error;
        throw new RunCleanupFailed('adapter cleanup failed', { cause: error });
      }
    })();
    return cleanupPromise;
  };
  const settlement = exitPromise.then(runCleanup);
  // Background cleanup must retain its original rejection for stop/wait.
  void settlement.catch(() => {});

  let stopInFlight: Promise<void> | undefined;
  const stopChild = (reason: JsonlFinishReason): Promise<void> => {
    if (stopInFlight) return stopInFlight;
    if (exited) return Promise.resolve();
    stopReason ??= reason;
    stopInFlight = (async () => {
      let signalError: unknown;
      if (child.pid) {
        log.info('agent', 'stop-sigterm', { pid: child.pid, graceMs: stopGraceMs });
        let signalled = false;
        try {
          signalled = child.kill('SIGTERM');
        } catch (error) {
          signalError = error;
        }
        if (signalled && await within(exitPromise, stopGraceMs) !== false) return;
        if (!exited) {
          log.warn('agent', 'stop-sigkill', {
            pid: child.pid, graceMs: stopGraceMs, reason: 'sigterm-did-not-exit',
          });
          try {
            child.kill('SIGKILL');
          } catch (error) {
            signalError = error;
          }
        }
      }
      if (await within(exitPromise, 5000) === false) {
        throw new RunCleanupFailed('child exit was not confirmed after stop', { cause: signalError });
      }
    })();
    void stopInFlight.catch(error => {
      runtimeError = error;
      rejectEventExit(error);
      // Wake event consumers even when a failed kill leaves stdout open.
      closeStdout();
    });
    return stopInFlight;
  };
  const stop = async (reason: JsonlFinishReason): Promise<void> => {
    await stopChild(reason);
    // Exit does not imply EOF: descendants may inherit the pipe. The runner
    // owns ending reads, while consumers still own draining the queued lines.
    await Promise.all([settlement, drainStoppedStdout()]);
  };
  const requestStop = (reason: JsonlFinishReason): void => {
    void stop(reason).catch(() => {});
  };

  const idleMs = input.timeouts?.idleMs;
  const totalMs = input.timeouts?.totalMs;
  const armIdle = (): void => {
    if (exited || stopReason || !idleMs || idleMs === Number.POSITIVE_INFINITY) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      requestStop('timeout');
    }, idleMs);
  };
  if (totalMs && totalMs !== Number.POSITIVE_INFINITY) {
    totalTimer = setTimeout(() => {
      requestStop('timeout');
    }, totalMs);
  }
  armIdle();

  const enqueueStdoutLine = (line: string): void => {
    if (!line) return;
    stdoutLines.push(line);
    armIdle();
  };

  child.stdout.on('data', (chunk: Buffer) => {
    if (stdoutClosed) return;
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
    if (silentExitTimer) clearTimeout(silentExitTimer);
    stdoutBuffer += stdoutDecoder.end();
    const tail = stdoutBuffer.trim();
    stdoutBuffer = '';
    enqueueStdoutLine(tail);
    onStdoutSettled();
  };
  child.stdout.on('end', closeStdout);
  child.stdout.on('close', closeStdout);

  let stdoutDrainPromise: Promise<void> | undefined;
  const drainStoppedStdout = (): Promise<void> => {
    stdoutDrainPromise ??= new Promise<void>((resolve, reject) => {
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = (error?: RunCleanupFailed): void => {
        if (finished) return;
        finished = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (deadline) clearTimeout(deadline);
        child.stdout.off('data', received);
        child.stdout.off('end', ended);
        child.stdout.off('close', ended);
        if (error) runtimeError ??= error;
        closeStdout();
        child.stdout.destroy();
        child.stderr.destroy();
        if (error) reject(error);
        else resolve();
      };
      const ended = (): void => finish();
      const received = (): void => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(ended, STOP_STDOUT_QUIET_MS);
      };
      if (stdoutClosed) {
        finish();
        return;
      }
      // After confirmed child exit, allow in-flight OS reads to arrive before
      // closing an inherited pipe. This is only a stopped-reader boundary,
      // never the bot's business idle timeout. Ongoing descendant output cannot
      // extend the total deadline or be silently mistaken for a drained pipe.
      child.stdout.on('data', received);
      child.stdout.once('end', ended);
      child.stdout.once('close', ended);
      received();
      deadline = setTimeout(() => finish(new RunCleanupFailed(
        'stdout did not quiesce after confirmed child exit',
      )), STOP_STDOUT_DRAIN_MS);
    });
    return stdoutDrainPromise;
  };

  child.on('error', (err) => {
    runtimeError = err;
    closeStdout();
    if (!child.pid) confirmExit(null);
  });
  child.on('exit', (code, signal) => {
    log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    confirmExit(code);
  });
  // The process may have exited between spawn and listener registration.
  if (child.exitCode !== null || child.signalCode !== null) confirmExit(child.exitCode);
  child.stdin.on('error', (err) => {
    log.warn('agent', 'stdin-error', { message: err.message });
  });
  if (typeof input.stdin === 'string') {
    child.stdin.end(input.stdin, 'utf8');
  } else {
    child.stdin.end();
  }

  if (input.emptyStdoutDestroyMs && input.emptyStdoutDestroyMs > 0) {
    const closeSilentStdout = (): void => {
      if (stdoutClosed || sawStdout) return;
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

  if (input.signal && !exited) {
    if (input.signal.aborted) {
      requestStop('interrupted');
    } else {
      abortHandler = () => {
        requestStop('interrupted');
      };
      input.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  let terminalEmitted = false;
  const events = iterateEvents({
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
    waitForExitCode: () => eventExit,
    onTerminal: () => { terminalEmitted = true; },
    cleanup: async terminal => {
      if (exited) await settlement;
      else if (!terminal) await stop('interrupted');
    },
  });
  return {
    runId: input.runId,
    events: {
      [Symbol.asyncIterator]() {
        return {
          next: () => events.next(),
          return: async () => {
            // Generator.return queues behind a pending next (and never enters
            // finally before the first next). Stop outside that queue first.
            if (!terminalEmitted) {
              await stop('interrupted');
            }
            return events.return(undefined);
          },
        };
      },
    },
    stop: () => stop('interrupted'),
    async waitForExit(timeoutMs: number): Promise<boolean> {
      return await within(settlement.then(() => true), timeoutMs) !== false;
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
  waitForExitCode: () => Promise<number | null>;
  onTerminal: () => void;
  cleanup: (terminal: boolean) => Promise<void>;
}): AsyncGenerator<AgentEvent> {
  let terminalSeen = false;
  let failed = false;
  function* emit(events: Iterable<AgentEvent>): Generator<AgentEvent> {
    for (const event of events) {
      if (event.type === 'done' || event.type === 'error') {
        terminalSeen = true;
        input.onTerminal();
      }
      yield event;
    }
  }
  try {
    if (!input.child.pid) {
      const err = input.getError();
      terminalSeen = true;
      input.onTerminal();
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
        yield* emit(input.translator.translate(line));
        line = input.stdout.nextLine();
      }
      if (input.stdout.closed()) break;
      await input.stdout.wait();
    }

    const earlyRuntimeError = input.getError();
    if (earlyRuntimeError instanceof RunCleanupFailed) throw earlyRuntimeError;
    if (earlyRuntimeError && input.child.exitCode === null && input.child.signalCode === null) {
      yield* emit(input.translator.fail(`${input.spawnName} runtime error: ${earlyRuntimeError.message}`));
      return;
    }

    const exitCode = await input.waitForExitCode();
    const stopReason = input.getStopReason();
    if (stopReason === 'interrupted' || stopReason === 'timeout') {
      if (stopReason === 'timeout' && !input.translator.terminalEmitted?.()) {
        terminalSeen = true;
        input.onTerminal();
        yield {
          type: 'error',
          message: `${input.spawnName} ${stopReason}`,
          terminationReason: 'timeout',
        };
        return;
      }
      yield* emit(input.translator.finish(stopReason));
      return;
    }

    const runtimeError = input.getError();
    const terminal = input.translator.terminalEmitted?.() === true;
    if (exitCode !== 0 && exitCode !== null) {
      if (!terminal || input.failNonzeroAfterTerminal) {
        const stderr = Buffer.concat(input.stderrChunks).toString('utf8').trim();
        const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
        yield* emit(input.translator.fail(`${input.spawnName} exited with code ${exitCode}${detail}`));
      }
      return;
    }
    if (runtimeError && !terminal) {
      yield* emit(input.translator.fail(`${input.spawnName} runtime error: ${runtimeError.message}`));
      return;
    }
    if (input.missingTerminalOnSuccess && !terminal) {
      yield* emit(input.translator.fail(input.missingTerminalOnSuccess));
      return;
    }
    yield* emit(input.translator.finish(input.successFinish));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await input.cleanup(terminalSeen && !failed);
  }
}

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T | false> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
