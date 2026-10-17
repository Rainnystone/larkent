import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import { createIdleWatchdog, TOOL_IDLE_PAUSE_CAP_MS } from '../../../src/bot/idle-watchdog';

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
