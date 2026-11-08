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
 * Idle watchdog shared by chat runs, agent-task fires, meeting answers, and
 * document-comment tasks.
 *
 * Budgets count awake time only: each scheduler tick credits at most `tickMs`.
 * Recovery may only extend remaining idle; it never reconstructs silence from
 * `Date.now() - lastEventAt` and never replaces an in-flight tool budget.
 * Heartbeat-only liveness is not progress. Disabled idle means no deadline.
 * Main-conversation output resets normal idle and never closes or slides an
 * open tool's cap. Parent Task/Agent names do not grant tool grace (Q3);
 * Claude `parent_tool_use_id` is always null in D03a captures and agy
 * `subagent_info` is unverified, so ancestry is not invented here.
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
  const tools = new Map<string, { used: number; name: string }>();
  const retired = new Set<string>();
  let timer: { cancel: () => void } | undefined;
  let timedOut = false;
  let disposed = false;

  const sample = (): void => {
    const t = now();
    const credit = creditAwakeDelta(t - lastSampleAt, tickMs);
    lastSampleAt = t;
    idleAwakeMs += credit;
    for (const [id, info] of tools) tools.set(id, { ...info, used: info.used + credit });
  };

  const remainingMs = (): number | undefined => {
    if (idleTimeoutMs === undefined) return undefined;
    if (tools.size > 0) {
      const cap = toolGraceMs(idleTimeoutMs);
      let minRem = Infinity;
      for (const info of tools.values()) minRem = Math.min(minRem, cap - info.used);
      return minRem;
    }
    return idleTimeoutMs - idleAwakeMs;
  };

  const stopLoop = (): void => {
    timer?.cancel();
    timer = undefined;
  };

  const fireTimeout = (timerKind: 'idle' | 'tool-grace', tool?: string): void => {
    if (timedOut || disposed || idleTimeoutMs === undefined) return;
    timedOut = true;
    stopLoop();
    const capMs = timerKind === 'tool-grace' ? toolGraceMs(idleTimeoutMs) : idleTimeoutMs;
    const awakeMinutes = Math.max(1, Math.round(capMs / 60_000));
    requestStop(handle, {
      type: 'bridge-idle-watchdog',
      timer: timerKind,
      ...(tool ? { tool } : {}),
      awakeMinutes,
    });
    log.warn('agent', 'idle-timeout', {
      ...(input.scope ? { scope: input.scope } : {}),
      idleTimeoutMs,
      timer: timerKind,
      ...(tool ? { tool } : {}),
      awakeMinutes,
    });
    void handle.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
  };

  const check = (): void => {
    sample();
    if (idleTimeoutMs === undefined) return;
    const cap = toolGraceMs(idleTimeoutMs);
    let lastExpired: string | undefined;
    for (const [id, info] of [...tools]) {
      if (info.used < cap) continue;
      tools.delete(id);
      retired.add(id);
      lastExpired = info.name;
      log.info('agent', 'tool-expired', { tool: info.name, inFlight: tools.size });
    }
    handle.hasOpenToolCall = tools.size > 0;
    if (lastExpired && tools.size === 0) {
      fireTimeout('tool-grace', lastExpired);
      return;
    }
    if (tools.size > 0) {
      let minRem = Infinity;
      for (const info of tools.values()) minRem = Math.min(minRem, cap - info.used);
      if (minRem <= 0) fireTimeout('tool-grace', tools.values().next().value?.name);
      return;
    }
    if (idleTimeoutMs - idleAwakeMs <= 0) fireTimeout('idle');
  };

  function idleWatchdogTick(): void {
    if (disposed || timedOut) return;
    check();
    if (disposed || timedOut || idleTimeoutMs === undefined) return;
    timer = schedule(idleWatchdogTick, tickMs);
  }

  const startLoop = (): void => {
    if (disposed || timedOut || idleTimeoutMs === undefined) return;
    stopLoop();
    lastSampleAt = now();
    timer = schedule(idleWatchdogTick, tickMs);
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
        if (retired.has(event.id) || !grantsToolGrace(event.name)) {
          handle.hasOpenToolCall = tools.size > 0;
        } else if (!tools.has(event.id)) {
          tools.set(event.id, { used: 0, name: event.name });
          handle.hasOpenToolCall = true;
          log.info('agent', 'tool-in-flight', {
            tool: event.name,
            inFlight: tools.size,
          });
        } else {
          handle.hasOpenToolCall = true;
        }
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

/** Parent Task/Agent wrappers wait on the model and must not grant 60-minute grace. */
function grantsToolGrace(name: string): boolean {
  return !/^(task|agent)$/i.test(name.trim());
}
