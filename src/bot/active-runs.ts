import type { AgentRun } from '../agent/types';
import { requestStop, type RunOutcome, type StopRequest } from './run-outcome';

export type { StopRequest };

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  stopRequest?: StopRequest;
  /** Set once by RunExecutor after child exit, cleanup and source drainage. */
  outcome?: RunOutcome;
  /** Last watchdog progress (or register time if none yet). Liveness does not advance this. */
  lastEventAt: number;
  /** True while the stream processor has a tool call in flight. */
  hasOpenToolCall?: boolean;
  /** Configured normal idle bound; recovery uses remaining time after an outage. */
  idleTimeoutMs?: number;
  /** Set by recovery when the run was silent before the outage. */
  stallDeadlineMs?: number;
  /** Leftover: recovery no longer skips later reviews based on this. */
  stallArmedAt?: number;
  /** Installed by the stream processor; treated as extend-only. */
  armStallDeadline?: (delayMs: number) => void;
  /** Watchdog-owned remaining awake budget; recovery must not reconstruct this from wall clocks. */
  remainingWatchdogMs?: () => number | undefined;
  /** Recovery may only raise this floor; it must not shorten an existing deadline. */
  extendWatchdogMs?: (minRemainingMs: number) => void;
}

export function noteRunEvent(handle: RunHandle, at = Date.now()): void {
  handle.lastEventAt = at;
}

export interface ActiveRunsHooks {
  onSupersede?: (scope: string) => void;
}

export interface PendingRerun {
  arm(): void;
  disarm(): StopRequest | undefined;
  stopRequest(): StopRequest | undefined;
  release(): void;
}

interface PendingRerunEntry {
  armed: boolean;
  stopRequest?: StopRequest;
}

export class ActiveRuns {
  constructor(private readonly hooks: ActiveRunsHooks = {}) {}

  private readonly handles = new Map<string, RunHandle>();
  private readonly reservations = new Set<string>();
  private readonly sessionWriters = new Map<string, Set<{ current: boolean }>>();
  private readonly pendingReruns = new Map<string, Set<PendingRerunEntry>>();
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

  trackPendingRerun(scope: string): PendingRerun {
    const entries = this.pendingReruns.get(scope) ?? new Set<PendingRerunEntry>();
    this.pendingReruns.set(scope, entries);
    const entry: PendingRerunEntry = { armed: false };
    entries.add(entry);
    return {
      arm: () => {
        entry.armed = true;
        entry.stopRequest = undefined;
      },
      disarm: () => {
        const stopRequest = entry.stopRequest;
        entry.armed = false;
        entry.stopRequest = undefined;
        return stopRequest;
      },
      stopRequest: () => entry.stopRequest,
      release: () => {
        entry.armed = false;
        entry.stopRequest = undefined;
        entries.delete(entry);
        if (entries.size === 0 && this.pendingReruns.get(scope) === entries) {
          this.pendingReruns.delete(scope);
        }
      },
    };
  }

  hasPendingRerun(scope: string): boolean {
    for (const entry of this.pendingReruns.get(scope) ?? []) {
      if (entry.armed) return true;
    }
    return false;
  }

  /** An accepted session choice revokes old consumers before requesting stop. */
  supersedeSession(scope: string, reason: StopRequest): boolean {
    this.hooks.onSupersede?.(scope);
    for (const writer of this.sessionWriters.get(scope) ?? []) writer.current = false;
    return this.interrupt(scope, reason);
  }

  /**
   * Interrupt the current run for this chat, if any, or cancel a pending
   * auto-rerun handoff between attempts. Returns true if an interrupt was
   * issued. The owner unregisters after asynchronous stop settlement; failures
   * remain visible to its finished/stopAll callers.
   */
  interrupt(chatId: string, reason: StopRequest): boolean {
    const h = this.handles.get(chatId);
    if (h) {
      requestStop(h, reason);
      void h.run.stop().catch(() => {
        // The owned run retains and reports settlement failure through finished/stopAll.
      });
      return true;
    }
    let interruptedPending = false;
    for (const entry of this.pendingReruns.get(chatId) ?? []) {
      if (!entry.armed) continue;
      entry.stopRequest ??= reason;
      interruptedPending = true;
    }
    return interruptedPending;
  }

  async stopAll(reason: StopRequest): Promise<void> {
    for (const entries of this.pendingReruns.values()) {
      for (const entry of entries) {
        if (entry.armed) entry.stopRequest ??= reason;
      }
    }
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
