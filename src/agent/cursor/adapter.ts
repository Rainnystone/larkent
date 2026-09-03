import type { Readable, Writable } from 'node:stream';
import { resolveCursorBinary } from '../../cli/agent-detection';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { assertCursorSandbox, buildCursorArgs } from './argv';
import { CursorJsonlTranslator, type CursorFinishReason } from './jsonl';

export interface CursorAdapterOptions {
  binary?: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type CursorChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

/**
 * Cursor Agent CLI adapter. Runs
 * `agent -p --output-format stream-json --force --sandbox disabled --approve-mcps --trust <prompt>`
 * per batch and resumes with `--resume <sessionId>`.
 *
 * Cursor has no `--append-system-prompt`; the bridge prompt is prefixed into
 * the positional argv prompt. Cursor home / login is inherited as-is
 * (`CURSOR_API_KEY` is passed through if already in the environment).
 */
export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor';
  readonly displayName = 'Cursor CLI';

  private binary: string;
  private readonly explicitBinary: boolean;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CursorAdapterOptions = {}) {
    this.explicitBinary = Boolean(opts.binary ?? process.env.LARK_CHANNEL_CURSOR_BIN);
    this.binary = opts.binary ?? process.env.LARK_CHANNEL_CURSOR_BIN ?? 'cursor-agent';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    if (!this.explicitBinary) {
      try {
        this.binary = await resolveCursorBinary();
      } catch {
        // Keep the default name so preflight can emit agent-binary-not-found.
      }
    }
    return checkAgentAvailability({
      agentId: 'cursor',
      agentName: 'Cursor CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(opts: AgentRunOptions): Promise<void> {
    assertCursorSandbox(opts.sandbox);
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'cursor binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CursorAdapter.run');
    }
    assertCursorSandbox(opts.sandbox);

    const args = buildCursorArgs({
      prompt: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
    });
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as CursorChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stdoutLines: string[] = [];
    let stdoutClosed = false;
    let stdoutNotify: (() => void) | undefined;
    const onStdoutSettled = (): void => {
      const notify = stdoutNotify;
      stdoutNotify = undefined;
      notify?.();
    };
    let stdoutBuffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      let nl = stdoutBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuffer.slice(0, nl).trim();
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (line) stdoutLines.push(line);
        nl = stdoutBuffer.indexOf('\n');
      }
      onStdoutSettled();
    });
    const closeStdout = (): void => {
      if (stdoutClosed) return;
      stdoutClosed = true;
      const tail = stdoutBuffer.trim();
      stdoutBuffer = '';
      if (tail) stdoutLines.push(tail);
      onStdoutSettled();
    };
    child.stdout.on('end', closeStdout);
    child.stdout.on('close', closeStdout);

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
          runtimeError = new Error(`failed to spawn cursor: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: CursorFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
      closeStdout();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end();

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
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

    return {
      runId: opts.runId,
      events: createEventStream(child, stdout, stderrChunks, () => runtimeError, () => stopReason),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
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
}

interface StdoutLineSource {
  nextLine(): string | undefined;
  closed(): boolean;
  wait(): Promise<void>;
}

async function* createEventStream(
  child: CursorChild,
  stdout: StdoutLineSource,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => CursorFinishReason | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new CursorJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn cursor: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  for (;;) {
    let line = stdout.nextLine();
    while (line !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        line = stdout.nextLine();
        continue;
      }
      yield* translator.translate(parsed);
      line = stdout.nextLine();
    }
    if (stdout.closed()) break;
    await stdout.wait();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield* translator.fail(`cursor runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield* translator.fail(`cursor exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(`cursor runtime error: ${runtimeError.message}`);
    return;
  }

  if (!translator.terminalEmitted()) {
    yield* translator.fail('cursor stream ended before a terminal event');
    return;
  }
}

async function waitForExitCode(child: CursorChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
