import type { AgentRun } from '../agent/types';
import { requestStop, type RunOutcome, type StopRequest } from './run-outcome';

export type { StopRequest };

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  stopRequest?: StopRequest;
  outcome?: RunOutcome;
  /** Last agent-stream event (or register time if none yet). */
  lastEventAt: number;
  /** Set by recovery when the run was silent before the outage. */
  stallDeadlineMs?: number;
  /** Installed by the stream processor so recovery can shorten the idle bound. */
  armStallDeadline?: (delayMs: number) => void;
}

export function noteRunEvent(handle: RunHandle, at = Date.now()): void {
  handle.lastEventAt = at;
}

export interface ActiveRunsHooks {
  onSupersede?: (scope: string) => void;
}

export class ActiveRuns {
  constructor(private readonly hooks: ActiveRunsHooks = {}) {}

  private readonly handles = new Map<string, RunHandle>();
  private readonly reservations = new Set<string>();
  private readonly sessionWriters = new Map<string, Set<{ current: boolean }>>();
  private pauseDepth = 0;
  private pauseReason: string | undefined;

  reserve(chatId: string): (() => void) | undefined {
    if (this.handles.has(chatId) || this.reservations.has(chatId)) return undefined;
    this.reservations.add(chatId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(chatId);
    };
  }

  register(chatId: string, run: AgentRun): RunHandle {
    if (this.handles.has(chatId)) {
      throw new Error(`run already active for scope: ${chatId}`);
    }
    this.reservations.delete(chatId);
    const handle: RunHandle = { run, interrupted: false, lastEventAt: Date.now() };
    this.handles.set(chatId, handle);
    return handle;
  }

  pauseNewRuns(reason: string): () => void {
    this.pauseDepth++;
    this.pauseReason = reason;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseDepth = Math.max(0, this.pauseDepth - 1);
      if (this.pauseDepth === 0) this.pauseReason = undefined;
    };
  }

  newRunsPaused(): boolean {
    return this.pauseDepth > 0;
  }

  newRunsPauseReason(): string | undefined {
    return this.pauseReason;
  }

  get(chatId: string): RunHandle | undefined {
    return this.handles.get(chatId);
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  snapshot(): RunHandle[] {
    return [...this.handles.values()];
  }

  scopes(): string[] {
    return [...this.handles.keys()];
  }

  /** A consumer can still save buffered events after its process unregisters. */
  trackSessionWriter(scope: string): { isCurrent(): boolean; release(): void } {
    const writers = this.sessionWriters.get(scope) ?? new Set<{ current: boolean }>();
    this.sessionWriters.set(scope, writers);
    const writer = { current: true };
    writers.add(writer);
    return {
      isCurrent: () => writer.current,
      release: () => {
        writers.delete(writer);
        if (writers.size === 0 && this.sessionWriters.get(scope) === writers) {
          this.sessionWriters.delete(scope);
        }
      },
    };
  }

  /** An accepted session choice revokes old consumers before requesting stop. */
  supersedeSession(scope: string, reason: StopRequest): boolean {
    this.hooks.onSupersede?.(scope);
    for (const writer of this.sessionWriters.get(scope) ?? []) writer.current = false;
    return this.interrupt(scope, reason);
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. The owner unregisters after asynchronous stop
   * settlement; failures remain visible to its finished/stopAll callers.
   */
  interrupt(chatId: string, reason: StopRequest): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    requestStop(h, reason);
    void h.run.stop().catch(() => {
      // The owned run retains and reports settlement failure through finished/stopAll.
    });
    return true;
  }

  async stopAll(reason: StopRequest): Promise<void> {
    const all = [...this.handles.values()];
    for (const h of all) requestStop(h, reason);
    const results = await Promise.allSettled(all.map((h) => h.run.stop()));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'failed to stop all active runs');
  }

  async waitForAll(timeoutMs = 300_000): Promise<void> {
    const all = [...this.handles.values()];
    const results = await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'failed to settle all active runs');
  }
}
