import { randomUUID } from 'node:crypto';
import { descriptorFor, isAgentKind } from '../agent/registry';
import { mergeAgentOptions, type AgentAdapter, type AgentEvent, type AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunCleanupFailed, RunRejected, SpawnFailed } from './errors';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
}

export interface SubmitRunInput {
  scopeId: string;
  policy: RunPolicyAllow;
  resumeHandle?: string;
  model?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
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

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
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
    if (this.activeRuns.newRunsPaused()) {
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
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      resumeHandle: input.resumeHandle,
      model: input.model,
      images: input.images,
      ...(mappedOptions !== undefined ? { agentOptions: mappedOptions } : {}),
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    let run: AgentRun;
    try {
      await this.agent.prepareRun?.(runOptions);
    } catch (err) {
      release();
      releaseScope();
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
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
    let handle: RunHandle;
    let finishing: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    let settled = false;
    const requestStop = (): Promise<void> => {
      stopping ??= (async () => { await rawRun.stop(); })();
      // A forced stop can reject while the graceful wait is still pending.
      void stopping.catch(() => {});
      return stopping;
    };
    const finish = (forceStop: boolean): Promise<void> => {
      if (forceStop && !settled) requestStop();
      finishing ??= (async () => {
        if (!(await rawRun.waitForExit(this.postDoneExitGraceMs))) {
          log.warn('run', 'post-done-exit-timeout', {
            ...dimensions, graceMs: this.postDoneExitGraceMs,
          });
          requestStop();
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
      waitForExit: timeoutMs => rawRun.waitForExit(timeoutMs),
      stop: () => {
        handle.interrupted = true;
        return fanout.stop();
      },
    };
    try {
      handle = this.activeRuns.register(input.scopeId, ownedRun);
    } catch (err) {
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
    const fanout = new EventFanout(observeRunEvents(rawRun.events, {
      dimensions,
      startedAt,
      now: this.now,
    }), finish, () => {
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
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (event.type === 'done') {
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
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
            if (wasActive && this.subscribers === 0 && !this.done) {
              if (!this.terminal) await this.stop();
              else await this.finished;
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
