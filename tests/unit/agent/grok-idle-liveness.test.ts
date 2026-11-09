import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import { createIdleWatchdog, noteWatchdogActivity, type IdleWatchdog } from '../../../src/bot/idle-watchdog';
import { shouldDeliverAgentEvent } from '../../../src/bot/run-outcome';

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
// Idle is longer than the held-back gaps so this test does not depend on
// liveness re-arming the watchdog (ticket 04: heartbeat is not progress).
const IDLE_MS = 60_000;
const GAP_MS = 4_000;
const CHUNKS = ['Held ', 'back ', 'answer ', 'stays ', 'whole.'];
const ANSWER = CHUNKS.join('');

afterEach(() => {
  vi.useRealTimers();
});

describe('Grok held-back answers and the idle watchdog', () => {
  it('delivers one final_text when text chunks outlast the idle timeout', async () => {
    vi.useFakeTimers();
    const handle = runHandle();
    const watchdog = createIdleWatchdog({ handle, idleTimeoutMs: IDLE_MS, scope: 'grok-answer' });
    const translator = new GrokJsonlTranslator();
    const delivered: AgentEvent[] = [];
    try {
      for (const chunk of CHUNKS) {
        await vi.advanceTimersByTimeAsync(GAP_MS);
        const activity = translator.translate({ type: 'text', data: chunk });
        expect(activity).toEqual([{ type: 'liveness', progress: true }]);
        consume(watchdog, handle, activity, delivered);
      }
      await vi.advanceTimersByTimeAsync(GAP_MS);
      consume(watchdog, handle, translator.translate({
        type: 'end',
        stopReason: 'end_turn',
        sessionId: SESSION,
      }), delivered);
      expect({
        stop: handle.stopRequest?.type,
        finals: delivered.filter((event) => event.type === 'final_text'),
        textDeltas: delivered.filter((event) => event.type === 'text'),
      }).toEqual({
        stop: undefined,
        finals: [{ type: 'final_text', content: ANSWER }],
        textDeltas: [],
      });
    } finally {
      watchdog.dispose();
    }
  });
});

/** Same consume path as processAgentStream: liveness is delivered to the watchdog, not rendered. */
function consume(
  watchdog: IdleWatchdog,
  handle: RunHandle,
  events: AgentEvent[],
  delivered: AgentEvent[],
): void {
  for (const event of events) {
    noteWatchdogActivity(handle, watchdog, event);
    if (event.type === 'system' || event.type === 'liveness') continue;
    if (!shouldDeliverAgentEvent(handle, event)) continue;
    delivered.push(event);
  }
}

function runHandle(): RunHandle {
  const run: AgentRun = {
    runId: 'run',
    events: (async function* () {})(),
    stop: async () => {},
    waitForExit: async () => true,
  };
  return { run, interrupted: false, lastEventAt: 0 };
}
