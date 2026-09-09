import type { AgentRun } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
}

export class ActiveRuns {
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
    const handle: RunHandle = { run, interrupted: false };
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
  supersedeSession(scope: string): boolean {
    for (const writer of this.sessionWriters.get(scope) ?? []) writer.current = false;
    return this.interrupt(scope);
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. The owner unregisters after asynchronous stop
   * settlement; failures remain visible to its finished/stopAll callers.
   */
  interrupt(chatId: string): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    h.interrupted = true;
    void h.run.stop().catch(() => {
      // The owned run retains and reports settlement failure through finished/stopAll.
    });
    return true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    for (const h of all) h.interrupted = true;
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
