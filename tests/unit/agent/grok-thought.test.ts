import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import type { AgentRun } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import { createIdleWatchdog } from '../../../src/bot/idle-watchdog';
import { consumeCotEvents, type CotPublisher } from '../../../src/bot/cot';
import { reduce, seedRunState } from '../../../src/card/run-state';
import { renderCard } from '../../../src/card/run-renderer';

const FIXTURE = new URL('../../fixtures/grok/s2-thoughts.jsonl', import.meta.url);

function loadEvents() {
  const translator = new GrokJsonlTranslator();
  return readFileSync(FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .flatMap((line) => translator.translate(JSON.parse(line) as unknown));
}

describe('Grok thoughts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps each thought to one thinking delta, once in CoT and once in the reasoning panel', async () => {
    const events = loadEvents();
    const thinking = events.filter((event) => event.type === 'thinking');
    expect(thinking.map((event) => event.type === 'thinking' ? event.delta : '')).toEqual([
      'Running the exact command',
      ' `node /tmp/probe.mjs`',
      ' now.',
    ]);
    const final = events.find((event) => event.type === 'final_text');
    expect(final).toEqual({ type: 'final_text', content: 'OK' });
    expect(JSON.stringify(final)).not.toContain('Running the exact command');

    let state = seedRunState({});
    for (const event of events) state = reduce(state, event);
    expect(state.reasoning.content).toBe('Running the exact command `node /tmp/probe.mjs` now.');
    const card = JSON.stringify(renderCard(state));
    const panelHits = card.split('Running the exact command').length - 1;
    expect(panelHits).toBe(1);
    expect(card).not.toContain('Running the exact command `node /tmp/probe.mjs` now.OK');

    const cot: { type: string; delta?: string }[] = [];
    const publisher = {
      runId: 'run-1',
      scope: 'scope-1',
      enqueue(eventType: string, content: unknown) {
        const body = content as { delta?: string };
        cot.push({ type: eventType, ...(body.delta !== undefined ? { delta: body.delta } : {}) });
      },
      async finish() {},
    } as unknown as CotPublisher;
    await consumeCotEvents((async function* () {
      for (const event of events) yield event;
    })(), publisher, { detail: 'brief' });
    const deltas = cot.filter((event) => event.type === 'REASONING_MESSAGE_CONTENT').map((event) => event.delta);
    expect(deltas).toEqual([
      'Running the exact command',
      ' `node /tmp/probe.mjs`',
      ' now.',
    ]);
  });

  it('resets the idle watchdog when a thought arrives', async () => {
    vi.useFakeTimers();
    const run: AgentRun = {
      runId: 'run',
      events: (async function* () {})(),
      stop: async () => {},
      waitForExit: async () => true,
    };
    const handle: RunHandle = { run, interrupted: false, lastEventAt: 0 };
    const watchdog = createIdleWatchdog({ handle, idleTimeoutMs: 1000, scope: 'thought' });
    await vi.advanceTimersByTimeAsync(900);
    const [thought] = new GrokJsonlTranslator().translate({
      type: 'thought',
      data: 'still working',
    });
    expect(thought).toEqual({ type: 'thinking', delta: 'still working' });
    if (!thought) return;
    watchdog.noteDelivered(thought);
    await vi.advanceTimersByTimeAsync(900);
    expect(handle.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(handle.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    watchdog.dispose();
  });
});
