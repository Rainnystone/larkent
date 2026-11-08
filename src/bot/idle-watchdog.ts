import type { AgentEvent } from '../agent/types';
import { log } from '../core/logger';
import { noteRunEvent, type RunHandle } from './active-runs';
import { requestStop } from './run-outcome';

/** While a tool is in flight, idle silence may last this long before the run is presumed hung. */
export const TOOL_IDLE_PAUSE_CAP_MS = 60 * 60_000;

/** Short tick used to credit awake silence. Gaps larger than one tick are not awake time. */
export const AWAKE_TICK_MS = 1_000;

export interface IdleWatchdogClock {
  now?: () => number;
  schedule?: (fn: () => void, delayMs: number) => { cancel: () => void };
  tickMs?: number;
}

export interface IdleWatchdog {
  arm(): void;
  noteDelivered(event: AgentEvent): void;
  dispose(): void;
  armedDelayMs(): number | undefined;
}

/**
 * Credit at most one tick of wall time per scheduler fire.
 * A 30-minute delta (macOS mach_continuous_time during sleep, or a paused
 * then-woken timer) is not 30 minutes of awake silence. Backward jumps
 * credit 0 and never reduce accumulated awake ms.
 */
export function creditAwakeDelta(rawDeltaMs: number, tickMs = AWAKE_TICK_MS): number {
  if (!Number.isFinite(rawDeltaMs) || rawDeltaMs <= 0) return 0;
  return Math.min(rawDeltaMs, tickMs);
}

export function toolGraceMs(idleTimeoutMs: number): number {
  return Math.max(TOOL_IDLE_PAUSE_CAP_MS, idleTimeoutMs);
}

export function isWatchdogProgress(event: AgentEvent): boolean {
  switch (event.type) {
    case 'text':
    case 'thinking':
    case 'tool_use':
    case 'tool_result':
    case 'final_text':
    case 'done':
    case 'error':
      return true;
    case 'liveness':
    case 'usage':
    case 'system':
      return false;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function noteWatchdogActivity(
  handle: RunHandle,
  watchdog: IdleWatchdog,
  event: AgentEvent,
  at?: number,
): void {
  if (isWatchdogProgress(event)) noteRunEvent(handle, at);
  if (!handle.interrupted) watchdog.noteDelivered(event);
}

/**
 * Idle watchdog shared by chat runs, agent-task fires, and meeting answers.
 *
 * Budgets count awake time only: each scheduler tick credits at most `tickMs`.
 * Recovery may only extend remaining idle; it never reconstructs silence from
 * `Date.now() - lastEventAt` and never replaces an in-flight tool budget.
 * Heartbeat-only liveness is not progress (ticket 07 splits grok held-back
 * mapping). Disabled idle means no deadline.
 */
export function createIdleWatchdog(input: {
  handle: RunHandle;
  idleTimeoutMs: number | undefined;
  scope?: string;
  clock?: IdleWatchdogClock;
}): IdleWatchdog {
  const { handle, idleTimeoutMs } = input;
  handle.idleTimeoutMs = idleTimeoutMs;
  const now = input.clock?.now ?? (() => Date.now());
  const tickMs = input.clock?.tickMs ?? AWAKE_TICK_MS;
  const schedule = input.clock?.schedule ?? ((fn: () => void, delayMs: number) => {
    const timer = setTimeout(fn, delayMs);
    return { cancel: () => clearTimeout(timer) };
  });

  let lastSampleAt = now();
  let idleAwakeMs = 0;
  const tools = new Map<string, number>();
  let timer: { cancel: () => void } | undefined;
  let timedOut = false;
  let disposed = false;

  const sample = (): void => {
    const t = now();
    const credit = creditAwakeDelta(t - lastSampleAt, tickMs);
    lastSampleAt = t;
    idleAwakeMs += credit;
    for (const [id, used] of tools) tools.set(id, used + credit);
  };

  const remainingMs = (): number | undefined => {
    if (idleTimeoutMs === undefined) return undefined;
    if (tools.size > 0) {
      const cap = toolGraceMs(idleTimeoutMs);
      let minRem = Infinity;
      for (const used of tools.values()) minRem = Math.min(minRem, cap - used);
      return minRem;
    }
    return idleTimeoutMs - idleAwakeMs;
  };

  const stopLoop = (): void => {
    timer?.cancel();
    timer = undefined;
  };

  const fireTimeout = (): void => {
    if (timedOut || disposed) return;
    timedOut = true;
    stopLoop();
    requestStop(handle, { type: 'bridge-idle-watchdog' });
    log.warn('agent', 'idle-timeout', {
      ...(input.scope ? { scope: input.scope } : {}),
      idleTimeoutMs,
    });
    void handle.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
  };

  const check = (): void => {
    sample();
    const remaining = remainingMs();
    if (remaining !== undefined && remaining <= 0) fireTimeout();
  };

  const loop = (): void => {
    if (disposed || timedOut) return;
    check();
    if (disposed || timedOut || idleTimeoutMs === undefined) return;
    timer = schedule(loop, tickMs);
  };

  const startLoop = (): void => {
    if (disposed || timedOut || idleTimeoutMs === undefined) return;
    stopLoop();
    lastSampleAt = now();
    timer = schedule(loop, tickMs);
  };

  const extend = (minRemainingMs: number): void => {
    if (idleTimeoutMs === undefined) return;
    if (tools.size > 0) return;
    sample();
    const remaining = idleTimeoutMs - idleAwakeMs;
    if (minRemainingMs > remaining) idleAwakeMs = idleTimeoutMs - minRemainingMs;
  };

  const resetIdle = (): void => {
    sample();
    idleAwakeMs = 0;
  };

  handle.remainingWatchdogMs = () => {
    sample();
    return remainingMs();
  };
  handle.extendWatchdogMs = extend;
  handle.armStallDeadline = extend;

  if (handle.stallDeadlineMs !== undefined) {
    extend(handle.stallDeadlineMs);
    delete handle.stallDeadlineMs;
  }
  startLoop();

  return {
    arm(): void {
      resetIdle();
      startLoop();
    },
    noteDelivered(event: AgentEvent): void {
      if (event.type === 'tool_result') {
        sample();
        tools.delete(event.id);
        handle.hasOpenToolCall = tools.size > 0;
        log.info('agent', 'tool-done', { inFlight: tools.size });
      }
      const progressed = isWatchdogProgress(event);
      if (progressed) resetIdle();
      if (event.type === 'tool_use') {
        tools.set(event.id, 0);
        handle.hasOpenToolCall = true;
        log.info('agent', 'tool-in-flight', {
          tool: event.name,
          inFlight: tools.size,
        });
      }
      if (progressed) startLoop();
    },
    dispose(): void {
      disposed = true;
      stopLoop();
      delete handle.armStallDeadline;
      delete handle.stallDeadlineMs;
      delete handle.stallArmedAt;
      delete handle.hasOpenToolCall;
      delete handle.remainingWatchdogMs;
      delete handle.extendWatchdogMs;
    },
    armedDelayMs: () => {
      if (idleTimeoutMs === undefined) return undefined;
      if (tools.size > 0) return toolGraceMs(idleTimeoutMs);
      return idleTimeoutMs;
    },
  };
}
