import { randomUUID } from 'node:crypto';
import { cliFailureInput, type CliSignature } from '../agent/cli-signatures';
import { descriptorFor, isAgentKind } from '../agent/registry';
import {
  mergeAgentOptions,
  type AgentAdapter,
  type AgentEvent,
  type AgentPromptVariant,
  type AgentRun,
} from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import {
  deriveRunOutcome,
  formatRunOutcome,
  formatStopRequest,
  requestStop,
  runOverlappedOutage,
  stopRequestFromTerminal,
} from '../bot/run-outcome';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunCleanupFailed, RunRejected, SpawnFailed } from './errors';
import { openToolRun, type ToolRun, type ToolRunContext } from '../bridge-tools/server';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
  stderrSignatures?: (variant?: AgentPromptVariant) => readonly CliSignature[] | undefined;
  /** Read the current Feishu link at spawn and settlement, including after a swap. */
  getLink?: () => { outageEpoch(): number; isDown(): boolean } | undefined;
  onSpawn?: (input: {
    scopeId: string;
    runId: string;
    pid?: number;
    startedAt: number;
  }) => void;
}

export interface SubmitRunInput {
  toolContext?: ToolRunContext;
  scopeId: string;
  policy: RunPolicyAllow;
  resumeHandle?: string;
  model?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  /**
   * Automation fires skip the process pool and reconnect pause (ADR-011).
   * Link-down is gated by the scheduler, not here.
   */
  bypassPool?: boolean;
  promptVariant?: AgentPromptVariant;
  /** Synchronous run decisions must precede buffering and outcome settlement. */
  onEvent?: (event: AgentEvent, handle: RunHandle) => void;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  /** Runtime settlement result; downstream consumers may still be processing events. */
  finished: Promise<void>;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  private readonly stderrSignatures?: RunExecutorDeps['stderrSignatures'];
  private readonly getLink?: RunExecutorDeps['getLink'];
  private readonly onSpawn?: RunExecutorDeps['onSpawn'];

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
    this.stderrSignatures = deps.stderrSignatures;
    this.getLink = deps.getLink;
    this.onSpawn = deps.onSpawn;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (!input.bypassPool && this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.bypassPool
      ? () => {}
      : input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      if (this.activeRuns.newRunsPaused()) {
        throw new RunRejected(
          'reconnect-in-progress',
          this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
        );
      }
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (!input.bypassPool && this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const mappedOptions = isAgentKind(this.agent.id)
      ? mergeAgentOptions(
          descriptorFor(this.agent.id).mapEffectiveAccess(input.policy.accessMode),
          {
            permissionMode: input.policy.permissionMode,
            sandbox: input.policy.sandbox,
          },
        )
      : undefined;
    let tools: ToolRun | undefined;
    try {
      if (input.toolContext) tools = await openToolRun({
        ...input.toolContext,
        runType: input.promptVariant === 'automation' ? 'automation' : 'im',
      });
    } catch (error) {
      release();
      releaseScope();
      throw new SpawnFailed('bridge tool connection failed', error);
    }
    const closeTools = (): Promise<void> => tools?.close() ?? Promise.resolve();
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      ...(tools ? { toolEnv: tools.env } : {}),
      cwd: input.policy.cwdRealpath,
      resumeHandle: input.resumeHandle,
      model: input.model,
      images: input.images,
      ...(mappedOptions !== undefined ? { agentOptions: mappedOptions } : {}),
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
      ...(input.promptVariant ? { promptVariant: input.promptVariant } : {}),
    };
    let run: AgentRun;
    try {
      await this.agent.prepareRun?.(runOptions);
    } catch (err) {
      await closeTools();
      release();
      releaseScope();
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (!input.bypassPool && this.activeRuns.newRunsPaused()) {
      await closeTools();
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const startedLink = this.getLink?.();
    const startedEpoch = startedLink?.outageEpoch() ?? 0;
    const startedDown = startedLink?.isDown() ?? false;
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
      await closeTools();
      release();
      releaseScope();
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    const rawRun = run;
    let handle!: RunHandle;
    let finishing: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    let settled = false;
    const stopChild = (): Promise<void> => {
      void closeTools().catch(() => {});
      stopping ??= (async () => { await rawRun.stop(); })();
      // A forced stop can reject while the graceful wait is still pending.
      void stopping.catch(() => {});
      return stopping;
    };
    const finish = (forceStop: boolean): Promise<void> => {
      const toolsClosed = closeTools();
      if (forceStop && !settled) {
        requestStop(handle, { type: 'subscriber-abandoned' });
        stopChild();
      }
      finishing ??= (async () => {
        await toolsClosed;
        if (!(await rawRun.waitForExit(this.postDoneExitGraceMs))) {
          log.warn('run', 'post-done-exit-timeout', {
            ...dimensions, graceMs: this.postDoneExitGraceMs,
          });
          stopChild();
        }
        if (stopping) {
          await stopping;
          if (!(await rawRun.waitForExit(this.postDoneExitGraceMs))) {
            throw new RunCleanupFailed('run did not settle after stop');
          }
        }
        settled = true;
      })();
      return finishing;
    };
    const ownedRun: AgentRun = {
      runId: rawRun.runId,
      events: rawRun.events,
      get stderrSnapshot() {
        return rawRun.stderrSnapshot;
      },
      get exit() {
        return rawRun.exit;
      },
      get signal() {
        return rawRun.signal;
      },
      pid: rawRun.pid,
      startedAt: rawRun.startedAt,
      waitForExit: timeoutMs => rawRun.waitForExit(timeoutMs),
      stop: () => {
        requestStop(handle, { type: 'subscriber-abandoned' });
        return fanout.stop();
      },
    };
    try {
      handle = this.activeRuns.register(input.scopeId, ownedRun);
    } catch (err) {
      await closeTools();
      // No owner was registered, but the spawned child still owns its slot.
      await rawRun.stop();
      if (!(await rawRun.waitForExit(this.postDoneExitGraceMs))) {
        throw new RunCleanupFailed('unregistered run did not settle after stop');
      }
      releaseScope();
      release();
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    this.onSpawn?.({
      scopeId: input.scopeId,
      runId,
      pid: rawRun.pid,
      startedAt: rawRun.startedAt ?? startedAt,
    });
    let terminalEvent: AgentEvent | undefined;
    const fanout = new EventFanout(observeRunEvents(rawRun.events, event => {
      input.onEvent?.(event, handle);
      if (isTerminalEvent(event)) terminalEvent = event;
    }), finish, () => {
      const stopRequest = handle.stopRequest
        ?? (terminalEvent ? stopRequestFromTerminal(terminalEvent) : undefined);
      const failure = cliFailureInput(rawRun.stderrSnapshot,
        terminalEvent?.type === 'error' ? terminalEvent.message : undefined,
        this.stderrSignatures?.(input.promptVariant));
      handle.outcome = deriveRunOutcome({
        stopRequest,
        terminalEvent,
        ...failure,
        exit: rawRun.exit,
        signal: rawRun.signal,
        outageOverlapped: runOverlappedOutage(this.getLink?.(), startedEpoch, startedDown),
      });
      if (terminalEvent?.type === 'error') {
        log.warn('run', 'failed', {
          ...dimensions,
          result: terminalEvent.terminationReason,
          durationMs: this.now() - startedAt,
          error: terminalEvent.message,
          ...(stopRequest ? { stopReason: formatStopRequest(stopRequest) } : {}),
          outcome: formatRunOutcome(handle.outcome),
        });
      } else if (terminalEvent?.type === 'done') {
        log.info('run', 'completed', {
          ...dimensions,
          result: terminalEvent.terminationReason,
          durationMs: this.now() - startedAt,
        });
      }
      // Raw exit/cleanup can finish before buffered source events. Release
      // ownership only once the pump has drained them (or observed failure).
      this.activeRuns.unregister(input.scopeId, ownedRun);
      releaseScope();
      release();
    });

    return {
      runId,
      scopeId: input.scopeId,
      run: ownedRun,
      handle,
      finished: fanout.finished,
      subscribe: () => fanout.subscribe(),
      stop: () => ownedRun.stop(),
    };
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  onEvent: (event: AgentEvent) => void,
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        onEvent(event);
        if (isTerminalEvent(event)) {
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  readonly finished: Promise<void>;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private subscribers = 0;
  private terminal = false;
  private done = false;
  private failed = false;
  private error: unknown;
  private resolveFinished!: () => void;
  private rejectFinished!: (error: unknown) => void;

  constructor(
    private readonly source: AsyncIterable<AgentEvent>,
    private readonly onDone: (forceStop: boolean) => Promise<void>,
    private readonly onSettled: () => void,
  ) {
    this.finished = new Promise<void>((resolve, reject) => {
      this.resolveFinished = resolve;
      this.rejectFinished = reject;
    });
    // Keep the original rejection observable for subscribers and finished.
    void this.finished.catch(() => {});
    void this.pump().catch(error => this.complete(true, error));
  }

  async stop(): Promise<void> {
    try {
      // Request raw stop immediately, including while the pump is already
      // waiting for graceful exit. Success still belongs to the source pump.
      await this.onDone(true);
    } catch (error) {
      // A broken child may never close its source. Wake callers with failure
      // while keeping its resource ownership for diagnosis.
      this.complete(true, error);
    }
    return this.finished;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        let active = false;
        let returned = false;
        const leave = (): void => {
          if (active) this.subscribers--;
          active = false;
        };
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            if (!active && !returned) {
              active = true;
              this.subscribers++;
            }
            for (;;) {
              if (returned) return { done: true, value: undefined };
              if (index < this.buffer.length) {
                return { done: false, value: this.buffer[index++]! };
              }
              if (this.done) {
                leave();
                returned = true;
                if (this.failed) throw this.error;
                return { done: true, value: undefined };
              }
              await new Promise<void>(resolve => {
                const wake = (): void => {
                  this.waiters.delete(wake);
                  resolve();
                };
                this.waiters.add(wake);
              });
            }
          },
          return: async (): Promise<IteratorResult<AgentEvent>> => {
            const wasActive = active;
            leave();
            returned = true;
            this.wakeAll();
            if (wasActive && !this.done) {
              if (this.terminal) await this.finished;
              else if (this.subscribers === 0) await this.stop();
            }
            if (this.failed) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  private async pump(): Promise<void> {
    let failed = false;
    let error: unknown;
    try {
      for await (const event of this.source) {
        if (this.done) break;
        this.buffer.push(event);
        this.terminal = isTerminalEvent(event);
        this.wakeAll();
        if (this.terminal) break;
      }
    } catch (err) {
      failed = true;
      error = err;
    } finally {
      await this.settle(failed, error);
    }
  }

  private async settle(failed: boolean, error?: unknown): Promise<void> {
    try {
      await this.onDone(false);
      this.onSettled();
    } catch (err) {
      failed = true;
      error = err;
    } finally {
      this.complete(failed, error);
    }
    return this.finished;
  }

  private complete(failed: boolean, error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.failed = failed;
    this.error = error;
    if (failed) this.rejectFinished(error);
    else this.resolveFinished();
    this.wakeAll();
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
