import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import { AWAKE_TICK_MS, createIdleWatchdog, TOOL_IDLE_PAUSE_CAP_MS } from '../../../src/bot/idle-watchdog';
import { replay, replayKinds, transcriptCase, type ReplayKind } from '../../helpers/transcript-replay';

const IDLE_MS = 15 * 60_000;
const TICK_MS = AWAKE_TICK_MS;

/**
 * D03a long-tool captures (owner machine, 2026-10-27). Headers: agy 1.4.8 (not
 * 1.5.3), claude 2.1.283, codex-cli 0.163.0, kimi 2.1.1, grok 1.0.71,
 * cursor-agent 2026.10.22-27dcf5f, devin 3000.11.228. Codex items are
 * command_execution only. Devin first tool_call already carries rawInput.
 * Recapture was not possible in the 06 rework VM (every CLI missing from PATH).
 */
const LONG_TOOL_KINDS: readonly ReplayKind[] = replayKinds;

describe('parametrized adapter tool grace from real captures', () => {
  it.each(LONG_TOOL_KINDS)(
    '%s long-tool stays alive at 16 awake minutes and stops after the 60-minute cap',
    (kind) => {
      const events = replay(transcriptCase(kind, 'long-tool'));
      const started = firstToolUse(events, kind);
      const clock = createFakeClock();
      const { handle, watchdog } = startWatch(clock);
      watchdog.noteDelivered(started);
      clock.elapse(16 * 60_000);
      expect(handle.interrupted, `${kind} died before 16m`).toBe(false);
      clock.elapse(TOOL_IDLE_PAUSE_CAP_MS - 16 * 60_000 - TICK_MS);
      expect(handle.interrupted, `${kind} died before 61m`).toBe(false);
      clock.elapse(TICK_MS + 1);
      expect(handle.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
      watchdog.dispose();
    },
  );

  it.each(LONG_TOOL_KINDS)(
    '%s matching tool completion returns to ordinary 15-minute idle',
    (kind) => {
      const events = replay(transcriptCase(kind, 'long-tool'));
      const started = firstToolUse(events, kind);
      const finished = matchingResult(events, started.id, kind);
      const clock = createFakeClock();
      const { handle, watchdog } = startWatch(clock);
      watchdog.noteDelivered(started);
      watchdog.noteDelivered(finished);
      clock.elapse(IDLE_MS - TICK_MS);
      expect(handle.interrupted, `${kind} died before ordinary idle`).toBe(false);
      clock.elapse(TICK_MS + 1);
      expect(handle.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
      watchdog.dispose();
    },
  );
});

function firstToolUse(events: AgentEvent[], kind: ReplayKind): Extract<AgentEvent, { type: 'tool_use' }> {
  const started = events.find((event) => event.type === 'tool_use');
  if (started?.type !== 'tool_use') {
    throw new Error(`${kind} long-tool capture did not emit tool_use`);
  }
  return started;
}

function matchingResult(
  events: AgentEvent[],
  id: string,
  kind: ReplayKind,
): Extract<AgentEvent, { type: 'tool_result' }> {
  const finished = events.find((event) => event.type === 'tool_result' && event.id === id);
  if (finished?.type !== 'tool_result') {
    throw new Error(`${kind} long-tool capture did not emit tool_result for ${id}`);
  }
  return finished;
}

function startWatch(clock: ReturnType<typeof createFakeClock>) {
  const handle = baseHandle();
  const watchdog = createIdleWatchdog({
    handle,
    idleTimeoutMs: IDLE_MS,
    scope: 'adapter-tool-grace',
    clock: { now: clock.now, schedule: clock.schedule, tickMs: TICK_MS },
  });
  return { handle, watchdog };
}

function baseHandle(): RunHandle {
  const run: AgentRun = {
    runId: 'run',
    events: (async function* () {})(),
    stop: async () => {},
    waitForExit: async () => true,
  };
  return { run, interrupted: false, lastEventAt: 0 };
}

type Scheduled = { at: number; fn: () => void };

function createFakeClock(start = 1_000_000) {
  let now = start;
  const timers = new Set<Scheduled>();

  const fireDue = (): void => {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const timer of [...timers]) {
        if (timer.at <= now) {
          timers.delete(timer);
          timer.fn();
          progressed = true;
        }
      }
    }
  };

  return {
    now: () => now,
    schedule: (fn: () => void, delayMs: number) => {
      const timer: Scheduled = { at: now + delayMs, fn };
      timers.add(timer);
      return { cancel: () => { timers.delete(timer); } };
    },
    elapse(ms: number) {
      const end = now + ms;
      while (now < end) {
        let nextAt = end;
        for (const timer of timers) {
          if (timer.at > now && timer.at < nextAt) nextAt = timer.at;
        }
        if ([...timers].some((timer) => timer.at <= now)) {
          fireDue();
          continue;
        }
        now = nextAt;
        fireDue();
      }
    },
  };
}
