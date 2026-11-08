import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import { AWAKE_TICK_MS, createIdleWatchdog, TOOL_IDLE_PAUSE_CAP_MS } from '../../../src/bot/idle-watchdog';
import { STALL_AFTER_RECOVERY_MS } from '../../../src/bot/recovery';

const IDLE_MS = 15 * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('idle watchdog', () => {
  it('pauses the idle bound while a tool is in flight and caps that pause at 60 minutes', async () => {
    vi.useFakeTimers();

    const quiet = handle();
    createIdleWatchdog({ handle: quiet, idleTimeoutMs: IDLE_MS, scope: 'quiet' });
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(quiet.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(quiet.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    expect(quiet.interrupted).toBe(true);

    const openTool = handle();
    const openWatch = createIdleWatchdog({
      handle: openTool,
      idleTimeoutMs: IDLE_MS,
      scope: 'tool',
    });
    openWatch.noteDelivered({ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} });
    expect(openTool.hasOpenToolCall).toBe(true);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(openTool.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(TOOL_IDLE_PAUSE_CAP_MS - IDLE_MS - 1);
    expect(openTool.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(openTool.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    expect(openTool.interrupted).toBe(true);
    openWatch.dispose();

    const afterTool = handle();
    const afterWatch = createIdleWatchdog({
      handle: afterTool,
      idleTimeoutMs: IDLE_MS,
      scope: 'after-tool',
    });
    afterWatch.noteDelivered({ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} });
    afterWatch.noteDelivered({
      type: 'tool_result',
      id: 'tool-1',
      output: 'done',
      isError: false,
    });
    expect(afterTool.hasOpenToolCall).toBe(false);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(afterTool.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(afterTool.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    afterWatch.dispose();
  });

  it('never shortens tool grace below configured idle of 120 minutes', async () => {
    vi.useFakeTimers();
    const longIdle = handle();
    const watch = createIdleWatchdog({
      handle: longIdle,
      idleTimeoutMs: 120 * 60_000,
      scope: 'long-idle-tool',
    });
    watch.noteDelivered({ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} });
    await vi.advanceTimersByTimeAsync(TOOL_IDLE_PAUSE_CAP_MS);
    expect(longIdle.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(longIdle.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(longIdle.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    watch.dispose();
  });

  it('does not cut remaining idle to the 2-minute recovery stall', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const remain = handle();
    remain.lastEventAt = 10_000_000;
    createIdleWatchdog({ handle: remain, idleTimeoutMs: IDLE_MS, scope: 'remain' });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    remain.armStallDeadline?.(STALL_AFTER_RECOVERY_MS);
    await vi.advanceTimersByTimeAsync(STALL_AFTER_RECOVERY_MS);
    expect(remain.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 3 * 60_000 - STALL_AFTER_RECOVERY_MS - 1);
    expect(remain.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(remain.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
  });

  it('restores the normal idle bound after a recovery stall when an agent event arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const live = handle();
    live.lastEventAt = 10_000_000;
    const watch = createIdleWatchdog({ handle: live, idleTimeoutMs: IDLE_MS, scope: 'event' });
    await vi.advanceTimersByTimeAsync(13 * 60_000);
    live.armStallDeadline?.(STALL_AFTER_RECOVERY_MS);
    watch.noteDelivered({ type: 'text', delta: 'still working' });
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(live.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(live.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    watch.dispose();
  });

  it('excludes a Date.now wall jump from fake-timer awake silence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const quiet = handle();
    createIdleWatchdog({ handle: quiet, idleTimeoutMs: IDLE_MS, scope: 'jump' });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 38_000);
    await vi.advanceTimersByTimeAsync(AWAKE_TICK_MS);
    expect(quiet.remainingWatchdogMs?.()).toBeGreaterThan(IDLE_MS - 4 * 60_000 - 2 * AWAKE_TICK_MS);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 4 * 60_000 - 2 * AWAKE_TICK_MS);
    expect(quiet.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(AWAKE_TICK_MS);
    expect(quiet.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
  });
});

function handle(): RunHandle {
  const run: AgentRun = {
    runId: 'run',
    events: (async function* () {})(),
    stop: async () => {},
    waitForExit: async () => true,
  };
  return { run, interrupted: false, lastEventAt: 0 };
}
