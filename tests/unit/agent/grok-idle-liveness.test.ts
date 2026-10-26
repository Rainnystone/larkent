import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import { createIdleWatchdog, type IdleWatchdog } from '../../../src/bot/idle-watchdog';
import { shouldDeliverAgentEvent } from '../../../src/bot/run-outcome';

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const IDLE_MS = 10_000;
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
        consume(watchdog, handle, translator.translate({ type: 'text', data: chunk }), delivered);
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

/** Same liveness rules as processAgentStream: system rearms, other events call noteDelivered. */
function consume(
  watchdog: IdleWatchdog,
  handle: RunHandle,
  events: AgentEvent[],
  delivered: AgentEvent[],
): void {
  for (const event of events) {
    if (event.type === 'system') {
      if (!handle.interrupted) watchdog.arm();
      continue;
    }
    if (!shouldDeliverAgentEvent(handle, event)) continue;
    watchdog.noteDelivered(event);
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
