import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildGrokArgs } from './argv';
import { GrokJsonlTranslator, type GrokFinishReason } from './jsonl';

export interface GrokAdapterOptions {
  binary?: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type GrokChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

/**
 * Grok Build CLI adapter. Runs
 * `grok -p <prompt> --output-format streaming-json --rules <bridge> --always-approve`
 * per batch and resumes with `-r <sessionId>`.
 *
 * Grok home (~/.grok, including auth.json) is inherited as-is — isolating
 * GROK_HOME would force a second device-code login for the bot.
 */
export class GrokAdapter implements AgentAdapter {
  readonly id = 'grok';
  readonly displayName = 'Grok Build';

  private readonly binary: string;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: GrokAdapterOptions = {}) {
    this.binary = opts.binary ?? 'grok';
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
    return checkAgentAvailability({
      agentId: 'grok',
      agentName: 'Grok Build',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'grok binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for GrokAdapter.run');
    }

    const args = buildGrokArgs({
      prompt: opts.prompt,
      rules: buildBridgeSystemPrompt(this.botIdentity),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    });
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, {
        ...buildLarkChannelEnv(this.larkChannel),
        GROK_DISABLE_AUTOUPDATER: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as GrokChild;

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
          runtimeError = new Error(`failed to spawn grok: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: GrokFinishReason | undefined;
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
  child: GrokChild,
  stdout: StdoutLineSource,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => GrokFinishReason | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new GrokJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn grok: ${err.message}` : 'spawn returned no pid',
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
    yield* translator.fail(`grok runtime error: ${earlyRuntimeError.message}`);
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
      yield* translator.fail(`grok exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(`grok runtime error: ${runtimeError.message}`);
    return;
  }

  yield* translator.finish('normal');
}

async function waitForExitCode(child: GrokChild): Promise<number | null> {
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
