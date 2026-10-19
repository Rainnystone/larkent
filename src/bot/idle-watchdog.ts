import type { AgentEvent } from '../agent/types';
import { log } from '../core/logger';
import type { RunHandle } from './active-runs';
import { requestStop } from './run-outcome';

/** While a tool is in flight, idle silence may last this long before the run is presumed hung. */
export const TOOL_IDLE_PAUSE_CAP_MS = 60 * 60_000;

export interface IdleWatchdog {
  arm(): void;
  noteDelivered(event: AgentEvent): void;
  dispose(): void;
  armedDelayMs(): number | undefined;
}

/**
 * Idle watchdog shared by chat runs and agent-task fires.
 *
 * Silence for `idleTimeoutMs` is presumed hung. An open tool call pauses that
 * bound (a long `lark-cli` OAuth or download can be quiet) but the pause
 * itself is capped at 60 minutes. Recovery can replace the delay with a
 * stall deadline (`handle.armStallDeadline`).
 */
export function createIdleWatchdog(input: {
  handle: RunHandle;
  idleTimeoutMs: number | undefined;
  scope?: string;
}): IdleWatchdog {
  const { handle, idleTimeoutMs } = input;
  let timer: NodeJS.Timeout | undefined;
  let armedDelayMs = idleTimeoutMs;
  let stallTimerArmed = false;
  const inFlightTools = new Set<string>();

  const clearIdleTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const armIdleTimer = (delayMs: number): void => {
    clearIdleTimer();
    delete handle.stallDeadlineMs;
    armedDelayMs = delayMs;
    timer = setTimeout(() => {
      requestStop(handle, { type: 'bridge-idle-watchdog' });
      log.warn('agent', 'idle-timeout', {
        ...(input.scope ? { scope: input.scope } : {}),
        idleTimeoutMs: delayMs,
      });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, delayMs);
  };

  const arm = (): void => {
    delete handle.stallDeadlineMs;
    delete handle.stallArmedAt;
    stallTimerArmed = false;
    if (!idleTimeoutMs) {
      clearIdleTimer();
      return;
    }
    const delayMs = inFlightTools.size > 0 ? TOOL_IDLE_PAUSE_CAP_MS : idleTimeoutMs;
    armIdleTimer(delayMs);
  };

  handle.armStallDeadline = (delayMs: number): void => {
    if (stallTimerArmed) return;
    stallTimerArmed = true;
    handle.stallArmedAt = Date.now();
    armIdleTimer(delayMs);
  };

  if (handle.stallDeadlineMs !== undefined) {
    handle.armStallDeadline(handle.stallDeadlineMs);
  } else {
    arm();
  }

  return {
    arm,
    noteDelivered(event: AgentEvent): void {
      if (event.type === 'tool_use') {
        inFlightTools.add(event.id);
        handle.hasOpenToolCall = true;
        log.info('agent', 'tool-in-flight', {
          tool: event.name,
          inFlight: inFlightTools.size,
        });
      } else if (event.type === 'tool_result') {
        inFlightTools.delete(event.id);
        handle.hasOpenToolCall = inFlightTools.size > 0;
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      }
      arm();
    },
    dispose(): void {
      clearIdleTimer();
      delete handle.armStallDeadline;
      delete handle.stallDeadlineMs;
      delete handle.stallArmedAt;
      delete handle.hasOpenToolCall;
    },
    armedDelayMs: () => armedDelayMs,
  };
}
