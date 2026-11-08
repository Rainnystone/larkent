import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import {
  AWAKE_TICK_MS,
  createIdleWatchdog,
  creditAwakeDelta,
  noteWatchdogActivity,
  TOOL_IDLE_PAUSE_CAP_MS,
} from '../../../src/bot/idle-watchdog';
import { reviewActiveRuns, STALL_AFTER_RECOVERY_MS } from '../../../src/bot/recovery';

const IDLE_MS = 15 * 60_000;
const TICK_MS = AWAKE_TICK_MS;
const THIRTY_MIN = 30 * 60_000;

describe('awake-time watchdog', () => {
  it('credits at most one tick for a 30-minute delta and nothing for a backward jump', () => {
    expect(creditAwakeDelta(THIRTY_MIN, TICK_MS)).toBe(TICK_MS);
    expect(creditAwakeDelta(-THIRTY_MIN, TICK_MS)).toBe(0);
    expect(creditAwakeDelta(0, TICK_MS)).toBe(0);
  });

  it('leaves 10 minutes of idle after 5 minutes awake and a 30-minute suspend (late tick)', () => {
    // Continuous timer: one overdue fire with a 30-minute delta (macOS-like).
    // src/platform/host-sleep.ts:182 — Node 20 hrtime is mach_continuous_time
    // and advances during sleep, so a single tick can carry a suspend-sized delta.
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    clock.elapse(5 * 60_000);
    clock.jump(30 * 60_000);
    clock.fireDue();
    expectRemaining(handle, 10 * 60_000);
    watchdog.dispose();
  });

  it('leaves 10 minutes of idle after a wall jump with a paused timer', () => {
    // Paused clock: timers do not fire during the jump; the next scheduled tick
    // after resume sees the large delta. Windows sleep-timer behavior is
    // unverified until checked; this shape is the conservative pause/resume model.
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    clock.elapse(5 * 60_000);
    clock.pause();
    clock.jump(30 * 60_000);
    clock.resume();
    clock.fireDue();
    expectRemaining(handle, 10 * 60_000);
    watchdog.dispose();
  });

  it('does not consume idle when the sleep probe reports not-suspended', () => {
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    noteProgress(watchdog, { type: 'text', delta: 'hi' }, clock, handle);
    clock.elapse(5 * 60_000);
    clock.jump(30 * 60_000);
    clock.fireDue();
    reviewActiveRuns([handle], {
      since: clock.now() - 30 * 60_000,
      until: clock.now(),
      hostSuspended: false,
    });
    expectRemaining(handle, 10 * 60_000);
    clock.elapse(STALL_AFTER_RECOVERY_MS);
    expect(handle.interrupted).toBe(false);
    watchdog.dispose();
  });

  it('does not consume idle when recovery never learns of the suspend', () => {
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    clock.elapse(5 * 60_000);
    clock.jump(30 * 60_000);
    clock.fireDue();
    expectRemaining(handle, 10 * 60_000);
    clock.elapse(10 * 60_000 - TICK_MS - 1);
    expect(handle.interrupted).toBe(false);
    clock.elapse(TICK_MS + 1);
    expect(handle.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    watchdog.dispose();
  });

  it('never brings an existing deadline forward on recovery', () => {
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    clock.elapse(3 * 60_000);
    const before = remaining(handle);
    expect(before).toBeGreaterThan(STALL_AFTER_RECOVERY_MS);
    reviewActiveRuns([handle], {
      since: clock.now() - 1_000,
      until: clock.now(),
      hostSuspended: false,
    });
    expect(remaining(handle)).toBe(before);
    clock.elapse(STALL_AFTER_RECOVERY_MS);
    expect(handle.interrupted).toBe(false);
    watchdog.dispose();
  });

  it('extends a short remaining idle up to the 2-minute recovery floor', () => {
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    clock.elapse(IDLE_MS - 30_000);
    expect(remaining(handle)).toBeLessThan(STALL_AFTER_RECOVERY_MS);
    reviewActiveRuns([handle], {
      since: clock.now() - 1_000,
      until: clock.now(),
      hostSuspended: false,
    });
    expectRemaining(handle, STALL_AFTER_RECOVERY_MS);
    clock.elapse(STALL_AFTER_RECOVERY_MS - 1);
    expect(handle.interrupted).toBe(false);
    clock.elapse(1);
    expect(handle.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    watchdog.dispose();
  });

  it('does not arm a 120-second stall when idle is disabled', () => {
    const clock = createFakeClock();
    const handle = baseHandle();
    const watchdog = createIdleWatchdog({
      handle,
      idleTimeoutMs: undefined,
      scope: 'disabled',
      clock: clock.deps(),
    });
    reviewActiveRuns([handle], {
      since: clock.now() - 1_000,
      until: clock.now(),
      hostSuspended: false,
    });
    expect(handle.stallDeadlineMs).toBeUndefined();
    expect(handle.remainingWatchdogMs?.()).toBeUndefined();
    clock.elapse(STALL_AFTER_RECOVERY_MS + IDLE_MS);
    expect(handle.interrupted).toBe(false);
    watchdog.dispose();
  });

  it('keeps 40 awake minutes of tool grace after 20 awake minutes and a suspend', () => {
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    noteProgress(watchdog, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }, clock, handle);
    clock.elapse(20 * 60_000);
    clock.jump(30 * 60_000);
    clock.fireDue();
    expectRemaining(handle, 40 * 60_000);
    reviewActiveRuns([handle], {
      since: clock.now() - 30 * 60_000,
      until: clock.now(),
      hostSuspended: true,
      suspendStartedAt: clock.now() - 30 * 60_000,
    });
    expectRemaining(handle, 40 * 60_000);
    expect(handle.stallDeadlineMs).toBeUndefined();
    watchdog.dispose();
  });

  it('keeps remaining tool grace across a late onSuspendAmended review', () => {
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    noteProgress(watchdog, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }, clock, handle);
    clock.elapse(20 * 60_000);
    clock.jump(30 * 60_000);
    clock.fireDue();
    reviewActiveRuns([handle], {
      since: clock.now() - 30 * 60_000,
      until: clock.now(),
      hostSuspended: false,
    });
    expectRemaining(handle, TOOL_IDLE_PAUSE_CAP_MS - 20 * 60_000);
    reviewActiveRuns([handle], {
      since: clock.now() - 30 * 60_000,
      until: clock.now(),
      hostSuspended: true,
      suspendStartedAt: clock.now() - 30 * 60_000,
    });
    expectRemaining(handle, TOOL_IDLE_PAUSE_CAP_MS - 20 * 60_000);
    clock.elapse(STALL_AFTER_RECOVERY_MS);
    expect(handle.interrupted).toBe(false);
    watchdog.dispose();
  });

  it('uses max(60 minutes, configured idle) from the tool start, not a sliding window', () => {
    const clock = createFakeClock();
    const idleMs = 120 * 60_000;
    const { handle, watchdog } = startWatch(clock, idleMs);
    noteProgress(watchdog, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }, clock, handle);
    noteProgress(watchdog, { type: 'text', delta: 'still going' }, clock, handle);
    clock.elapse(60 * 60_000);
    expect(handle.interrupted).toBe(false);
    expectRemaining(handle, 60 * 60_000);
    clock.elapse(60 * 60_000 - 1);
    expect(handle.interrupted).toBe(false);
    clock.elapse(1);
    expect(handle.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    watchdog.dispose();
  });

  it('does not renew per-tool start when the same tool_use id repeats', () => {
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    noteProgress(watchdog, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }, clock, handle);
    clock.elapse(20 * 60_000);
    expectRemaining(handle, TOOL_IDLE_PAUSE_CAP_MS - 20 * 60_000);
    noteProgress(watchdog, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }, clock, handle);
    expectRemaining(handle, TOOL_IDLE_PAUSE_CAP_MS - 20 * 60_000);
    clock.elapse(TOOL_IDLE_PAUSE_CAP_MS - 20 * 60_000 - 1);
    expect(handle.interrupted).toBe(false);
    clock.elapse(1);
    expect(handle.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    watchdog.dispose();
  });

  it('does not treat heartbeat-only liveness as idle progress', () => {
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    const started = remaining(handle);
    watchdog.noteDelivered({ type: 'liveness' });
    watchdog.noteDelivered({ type: 'usage', inputTokens: 1 });
    watchdog.noteDelivered({ type: 'system', model: 'x' });
    expect(handle.lastEventAt).toBe(0);
    expect(remaining(handle)).toBe(started);
    clock.elapse(IDLE_MS - 1);
    watchdog.noteDelivered({ type: 'liveness' });
    clock.elapse(1);
    expect(handle.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    watchdog.dispose();
  });

  it('treats held-back text as progress on the shared activity seam', () => {
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    clock.elapse(5 * 60_000);
    noteProgress(watchdog, { type: 'text', delta: 'partial', heldBack: true }, clock, handle);
    expect(handle.lastEventAt).toBe(clock.now());
    expectRemaining(handle, IDLE_MS);
    watchdog.dispose();
  });

  it('excludes two suspends in one silent run even after a recovery floor was armed', () => {
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    clock.elapse(IDLE_MS - 30_000);
    reviewActiveRuns([handle], {
      since: clock.now() - 1_000,
      until: clock.now(),
      hostSuspended: false,
    });
    expectRemaining(handle, STALL_AFTER_RECOVERY_MS);
    clock.jump(30 * 60_000);
    clock.fireDue();
    clock.elapse(10_000);
    clock.jump(30 * 60_000);
    clock.fireDue();
    reviewActiveRuns([handle], {
      since: clock.now() - 30 * 60_000,
      until: clock.now(),
      hostSuspended: true,
      suspendStartedAt: clock.now() - 30 * 60_000,
    });
    expect(remaining(handle)).toBeGreaterThan(STALL_AFTER_RECOVERY_MS - 10_000 - 3 * TICK_MS);
    expect(handle.interrupted).toBe(false);
    watchdog.dispose();
  });

  it('ignores forward and backward wall-clock jumps when crediting awake silence', () => {
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    clock.elapse(5 * 60_000);
    const afterFive = remaining(handle);
    clock.jump(60 * 60_000);
    clock.fireDue();
    expect(remaining(handle)).toBeLessThanOrEqual(afterFive);
    expect(remaining(handle)).toBeGreaterThan(afterFive - 2 * TICK_MS);
    clock.jump(-(2 * 60 * 60_000));
    clock.fireDue();
    const afterBack = remaining(handle);
    expect(afterBack).toBeLessThanOrEqual(afterFive);
    expect(afterBack).toBeGreaterThan(afterFive - 3 * TICK_MS);
    watchdog.dispose();
  });

});

type Scheduled = { at: number; fn: () => void; paused?: boolean };

function createFakeClock(start = 1_000_000) {
  let now = start;
  let paused = false;
  const timers = new Set<Scheduled>();

  const fireDue = (): void => {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const timer of [...timers]) {
        if (paused || timer.paused) continue;
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
      return {
        cancel: () => {
          timers.delete(timer);
        },
      };
    },
    jump(ms: number) {
      now += ms;
    },
    fireDue,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    elapse(ms: number) {
      const end = now + ms;
      while (now < end) {
        if (paused) {
          now = end;
          return;
        }
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
    deps() {
      return { now: () => now, schedule: this.schedule, tickMs: TICK_MS };
    },
  };
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

function startWatch(clock: ReturnType<typeof createFakeClock>, idleTimeoutMs = IDLE_MS) {
  const handle = baseHandle();
  const watchdog = createIdleWatchdog({
    handle,
    idleTimeoutMs,
    scope: 'awake',
    clock: { now: clock.now, schedule: clock.schedule, tickMs: TICK_MS },
  });
  return { handle, watchdog };
}

function remaining(handle: RunHandle): number {
  const ms = handle.remainingWatchdogMs?.();
  if (ms === undefined) throw new Error('watchdog remaining is missing');
  return ms;
}

function expectRemaining(handle: RunHandle, expected: number): void {
  const ms = remaining(handle);
  expect(ms).toBeGreaterThan(expected - 2 * TICK_MS);
  expect(ms).toBeLessThanOrEqual(expected);
}

function noteProgress(
  watchdog: Parameters<typeof noteWatchdogActivity>[1],
  event: AgentEvent,
  clock: ReturnType<typeof createFakeClock>,
  handle?: RunHandle,
): void {
  if (!handle) return;
  noteWatchdogActivity(handle, watchdog, event, clock.now());
}
