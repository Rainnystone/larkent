import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import type { AgentEvent, AgentRun } from '../types';
import {
  JsonlRunAborted,
  type JsonlAbortKind,
  type JsonlTranslator,
} from './jsonl-translator';

export type {
  JsonlAbortKind,
  JsonlFailDisposition,
  JsonlFailMode,
  JsonlPrepareResult,
  JsonlTranslator,
} from './jsonl-translator';
export {
  JsonlRunAborted,
  jsonlErrorMessage,
  jsonlFailDisposition,
  parseJsonlLine,
  truncateJsonlMessage,
} from './jsonl-translator';

export interface JsonlCliRunnerInput {
  binaryPath: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  translator: JsonlTranslator;
  cleanup?: () => Promise<void>;
  signal: AbortSignal;
  timeouts: { idleMs: number; totalMs: number };
  name: string;
  stopGraceMs?: number;
}

export interface JsonlCliHandle extends AsyncIterable<AgentEvent> {
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

type JsonlChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

interface LineQueue {
  nextLine(): string | undefined;
  closed(): boolean;
  wait(): Promise<void>;
  close(): void;
}

interface JsonlCliSession {
  readonly child: JsonlChild;
  readonly translator: JsonlTranslator;
  readonly name: string;
  readonly stdout: LineQueue;
  readonly stderrChunks: Buffer[];
  readonly stopGraceMs: number;
  killReason: JsonlAbortKind | undefined;
  timeoutKind: 'idle' | 'total' | undefined;
  runtimeError: Error | null;
  stop(): Promise<void>;
  waitForExit(timeoutMs: number): Promise<boolean>;
  getError(): Error | null;
  clearTimers(): void;
}

export function runJsonlCli(input: JsonlCliRunnerInput): JsonlCliHandle {
  const session = startJsonlCli(input);
  const events = streamJsonlCli(session, input);
  return {
    events,
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      yield* events;
    },
    stop: () => session.stop(),
    waitForExit: (timeoutMs) => session.waitForExit(timeoutMs),
  };
}

export function runJsonlAgent(input: {
  runId: string;
  name: string;
  binaryPath: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  translator: JsonlTranslator;
  cleanup?: () => Promise<void>;
  stopGraceMs: number;
}): AgentRun {
  const handle = runJsonlCli({
    binaryPath: input.binaryPath,
    argv: input.argv,
    cwd: input.cwd,
    env: input.env,
    stdin: input.stdin,
    translator: input.translator,
    cleanup: input.cleanup,
    signal: new AbortController().signal,
    timeouts: { idleMs: 0, totalMs: 0 },
    name: input.name,
    stopGraceMs: input.stopGraceMs,
  });
  return {
    runId: input.runId,
    events: handle.events,
    stop: () => handle.stop(),
    waitForExit: (timeoutMs) => handle.waitForExit(timeoutMs),
  };
}

function startJsonlCli(input: JsonlCliRunnerInput): JsonlCliSession {
  const stopGraceMs = input.stopGraceMs ?? 5000;
  const child = spawnProcess(input.binaryPath, input.argv, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as JsonlChild;

  log.info('agent', 'spawn', {
    pid: child.pid ?? null,
    cwd: input.cwd,
    binaryPath: input.binaryPath,
    argvCount: input.argv.length,
    stdinChars: input.stdin?.length ?? 0,
  });

  const stderrChunks: Buffer[] = [];
  let runtimeError: Error | null = null;
  let stderrBuffer = '';
  let killReason: JsonlAbortKind | undefined;
  let timeoutKind: 'idle' | 'total' | undefined;
  let stopping: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  let sawStdout = false;

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    if (silentExitTimer) clearTimeout(silentExitTimer);
    idleTimer = undefined;
    totalTimer = undefined;
    silentExitTimer = undefined;
  };

  const armIdle = (): void => {
    if (input.timeouts.idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timeoutKind = 'idle';
      void kill('timeout');
    }, input.timeouts.idleMs);
  };

  const stdout = attachLineQueue(child.stdout, () => {
    sawStdout = true;
    armIdle();
  });

  if (input.timeouts.totalMs > 0) {
    totalTimer = setTimeout(() => {
      timeoutKind = 'total';
      void kill('timeout');
    }, input.timeouts.totalMs);
  }
  armIdle();

  const cleanupOnce = once(async () => {
    clearTimers();
    if (input.cleanup) await input.cleanup();
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrBuffer += chunk.toString('utf8');
    let nl = stderrBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stderrBuffer.slice(0, nl);
      stderrBuffer = stderrBuffer.slice(nl + 1);
      if (line.trim()) log.warn('agent', 'stderr', { line });
      if (isWindowsCommandNotFoundLine(line)) {
        runtimeError = new Error(`failed to spawn ${input.name}: ${line.trim()}`);
        child.stdout.destroy();
        child.kill();
      }
      nl = stderrBuffer.indexOf('\n');
    }
  });

  child.on('error', (err) => {
    runtimeError = err;
    stdout.close();
    void cleanupOnce();
  });
  child.on('exit', (code, signal) => {
    log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
    void cleanupOnce();
  });
  child.stdin.on('error', (err) => {
    log.warn('agent', 'stdin-error', { message: err.message });
  });
  if (input.stdin !== undefined) {
    child.stdin.end(input.stdin, 'utf8');
  } else {
    child.stdin.end();
  }

  async function kill(reason: JsonlAbortKind): Promise<void> {
    if (killReason === undefined) killReason = reason;
    if (child.exitCode !== null || child.signalCode !== null) {
      stdout.close();
      return;
    }
    log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
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
    stdout.close();
  }

  const onAbort = (): void => {
    void kill('abort');
  };
  if (input.signal.aborted) {
    void kill('abort');
  } else {
    input.signal.addEventListener('abort', onAbort, { once: true });
    child.once('exit', () => {
      input.signal.removeEventListener('abort', onAbort);
    });
  }

  return {
    child,
    translator: input.translator,
    name: input.name,
    stdout,
    stderrChunks,
    stopGraceMs,
    get killReason() {
      return killReason;
    },
    set killReason(value) {
      killReason = value;
    },
    get timeoutKind() {
      return timeoutKind;
    },
    set timeoutKind(value) {
      timeoutKind = value;
    },
    get runtimeError() {
      return runtimeError;
    },
    set runtimeError(value) {
      runtimeError = value;
    },
    getError: () => runtimeError,
    clearTimers,
    async stop() {
      if (!stopping) stopping = kill('stop');
      await stopping;
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

async function* streamJsonlCli(
  session: JsonlCliSession,
  input: JsonlCliRunnerInput,
): AsyncGenerator<AgentEvent> {
  const { child, translator, name, stdout } = session;
  try {
    if (!child.pid) {
      await Promise.resolve();
      const err = session.getError();
      yield* translator.fail(
        new Error(err ? `failed to spawn ${name}: ${err.message}` : 'spawn returned no pid'),
      );
      return;
    }

    for (;;) {
      let line = stdout.nextLine();
      while (line !== undefined) {
        for (const event of translator.translate(line)) {
          yield event;
          if (event.type === 'done' || event.type === 'error') {
            return;
          }
        }
        line = stdout.nextLine();
      }
      if (stdout.closed()) break;
      await stdout.wait();
    }

    const earlyRuntimeError = session.getError();
    if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
      yield* translator.fail(new Error(`${name} runtime error: ${earlyRuntimeError.message}`));
      return;
    }

    const exitCode = await waitForExitCode(child);
    if (session.killReason === 'stop') {
      yield* translator.fail(new JsonlRunAborted('stop', `${name} run stopped`));
      return;
    }
    if (session.killReason === 'timeout') {
      const which = session.timeoutKind ?? 'idle';
      yield* translator.fail(new JsonlRunAborted('timeout', `${name} ${which} timeout`));
      return;
    }
    if (session.killReason === 'abort' || input.signal.aborted) {
      yield* translator.fail(new JsonlRunAborted('abort', `${name} run aborted`));
      return;
    }

    const runtimeError = session.getError();
    if (exitCode !== 0 && exitCode !== null) {
      const stderr = Buffer.concat(session.stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield* translator.fail(new Error(`${name} exited with code ${exitCode}${detail}`));
      return;
    }
    if (runtimeError) {
      yield* translator.fail(new Error(`${name} runtime error: ${runtimeError.message}`));
      return;
    }

    yield* translator.finish();
  } finally {
    session.clearTimers();
  }
}

async function waitForExitCode(child: JsonlChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function attachLineQueue(stream: Readable, onLine?: () => void): LineQueue {
  const lines: string[] = [];
  let closed = false;
  let notify: (() => void) | undefined;
  let buffer = '';
  const pushLine = (line: string): void => {
    lines.push(line);
    onLine?.();
  };
  const settle = (): void => {
    const current = notify;
    notify = undefined;
    current?.();
  };
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) pushLine(line);
      nl = buffer.indexOf('\n');
    }
    settle();
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    const tail = buffer.trim();
    buffer = '';
    if (tail) pushLine(tail);
    settle();
  };
  stream.on('end', close);
  stream.on('close', close);
  return {
    nextLine(): string | undefined {
      return lines.shift();
    },
    closed(): boolean {
      return closed;
    },
    wait(): Promise<void> {
      if (closed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        notify = resolve;
      });
    },
    close,
  };
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) pending = fn();
    return pending;
  };
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
