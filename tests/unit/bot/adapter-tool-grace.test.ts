import { describe, expect, it } from 'vitest';
import { AntigravityJsonlTranslator } from '../../../src/agent/antigravity/jsonl';
import { CursorJsonlTranslator } from '../../../src/agent/cursor/jsonl';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import { AWAKE_TICK_MS, createIdleWatchdog, noteWatchdogActivity, TOOL_IDLE_PAUSE_CAP_MS } from '../../../src/bot/idle-watchdog';
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
      expect(handle.stopRequest).toMatchObject({ type: 'bridge-idle-watchdog' });
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
      expect(handle.stopRequest).toMatchObject({ type: 'bridge-idle-watchdog' });
      watchdog.dispose();
    },
  );
});

describe('heartbeat-only adapter liveness never extends tool grace', () => {
  it('stops at the original Bash cap while cursor retry/connection pings continue', () => {
    const cursor = new CursorJsonlTranslator();
    const heartbeats = [
      ...cursor.translate({ type: 'retry', attempt: 1 }),
      ...cursor.translate({ type: 'connection' }),
    ];
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats.every((event) => event.type === 'liveness')).toBe(true);
    expectOpenToolIgnoresHeartbeats(heartbeats);
  });

  it('stops at the original Bash cap while grok in_progress/pending pings continue', () => {
    const grok = new GrokJsonlTranslator();
    grok.translate({
      type: 'tool_call',
      toolCallId: 'call-1',
      toolName: 'bash',
      status: 'started',
    });
    const heartbeats = [
      ...grok.translate({
        type: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'in_progress',
      }),
      ...grok.translate({
        type: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'pending',
      }),
    ];
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats.every((event) => event.type === 'liveness')).toBe(true);
    expectOpenToolIgnoresHeartbeats(heartbeats);
  });
});

describe('held-back model output refreshes ordinary idle', () => {
  const chunkers: Array<[string, () => (i: number) => AgentEvent[]]> = [
    ['grok text chunks', () => {
      const grok = new GrokJsonlTranslator();
      return (i) => grok.translate({ type: 'text', data: `chunk ${i} ` });
    }],
    ['agy agent_response deltas', () => {
      const agy = new AntigravityJsonlTranslator();
      return (i) => agy.translate({ event: 'step_update', step_update: {
        conversation_id: 'conv-1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: `chunk ${i} `,
      } });
    }],
    ['cursor thinking deltas', () => {
      const cursor = new CursorJsonlTranslator();
      return (i) => cursor.translate({ type: 'thinking', subtype: 'delta', text: `thought ${i} `, session_id: 's-1' });
    }],
  ];

  it.each(chunkers)('%s every minute keep a run alive past idle, then silence stops it', (_label, makeChunker) => {
    const chunk = makeChunker();
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    for (let i = 0; i < 30; i++) {
      for (const event of chunk(i)) noteWatchdogActivity(handle, watchdog, event);
      clock.elapse(60_000);
    }
    expect(handle.interrupted, 'continuous output was cut at idle').toBe(false);
    clock.elapse(IDLE_MS + TICK_MS);
    expect(handle.stopRequest).toMatchObject({ type: 'bridge-idle-watchdog', timer: 'idle' });
    watchdog.dispose();
  });

  it('keeps cursor thinking completion and retry pings heartbeat-only', () => {
    const cursor = new CursorJsonlTranslator();
    const pings = [
      ...cursor.translate({ type: 'thinking', subtype: 'completed', session_id: 's-1' }),
      ...cursor.translate({ type: 'retry', attempt: 1 }),
    ];
    const clock = createFakeClock();
    const { handle, watchdog } = startWatch(clock);
    for (let i = 0; i < 30 && !handle.interrupted; i++) {
      for (const event of pings) noteWatchdogActivity(handle, watchdog, event);
      clock.elapse(60_000);
    }
    expect(handle.stopRequest).toMatchObject({ type: 'bridge-idle-watchdog', timer: 'idle' });
    watchdog.dispose();
  });
});

function expectOpenToolIgnoresHeartbeats(heartbeats: AgentEvent[]): void {
  const clock = createFakeClock();
  const { handle, watchdog } = startWatch(clock);
  const startedAt = clock.now();
  noteWatchdogActivity(handle, watchdog, { type: 'tool_use', id: 't1', name: 'Bash', input: {} });
  for (let i = 0; i < 240 && !handle.interrupted; i++) {
    noteWatchdogActivity(handle, watchdog, heartbeats[i % heartbeats.length]!);
    clock.elapse(30_000);
  }
  expect(handle.interrupted).toBe(true);
  expect(clock.now() - startedAt).toBeGreaterThan(59 * 60_000);
  expect(clock.now() - startedAt).toBeLessThan(61 * 60_000);
  expect(handle.stopRequest).toMatchObject({
    type: 'bridge-idle-watchdog',
    timer: 'tool-grace',
    tool: 'Bash',
    awakeMinutes: 60,
  });
  watchdog.dispose();
}

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
