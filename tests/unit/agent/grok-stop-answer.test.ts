import { describe, expect, it } from 'vitest';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import { finalReplyFor } from '../../../src/bot/cot';
import { requestStop, shouldDeliverAgentEvent, type StopRequest } from '../../../src/bot/run-outcome';
import { reduce, seedRunState, type RunState } from '../../../src/card/run-state';
import { renderCard } from '../../../src/card/run-renderer';
import type { AgentEvent } from '../../../src/agent/types';

function cardAfterStop(events: AgentEvent[], stop: StopRequest): RunState {
  const handle = { interrupted: false };
  requestStop(handle, stop);
  let state = seedRunState({});
  for (const event of events) {
    if (!shouldDeliverAgentEvent(handle, event)) continue;
    state = reduce(state, event);
  }
  return finalReplyFor(state, { replyMode: 'final-answer', streamed: false });
}

function stoppedAnswer(chunks: string[], stop: StopRequest): string {
  const translator = new GrokJsonlTranslator();
  for (const chunk of chunks) translator.translate({ type: 'text', data: chunk });
  const state = cardAfterStop(translator.finish('interrupted'), stop);
  return JSON.stringify(renderCard(state));
}

describe('Grok answer survives stop', () => {
  it('delivers held text as the card answer after an idle-watchdog stop', () => {
    const card = stoppedAnswer(['answer ', 'before stop'], { type: 'bridge-idle-watchdog' });
    expect(card).toContain('answer before stop');
  });

  it('delivers held text as the card answer after a user stop', () => {
    const card = stoppedAnswer(['answer ', 'before stop'], { type: 'user-stop' });
    expect(card).toContain('answer before stop');
  });

  it('keeps text that arrived before a tool call', () => {
    const translator = new GrokJsonlTranslator();
    const events = [
      ...translator.translate({ type: 'text', data: 'before the tool' }),
      ...translator.translate({
        type: 'tool_call',
        toolCallId: 'call_1',
        toolName: 'read_file',
        status: 'in_progress',
        rawInput: { path: 'a.ts' },
      }),
      ...translator.translate({ type: 'text', data: 'after' }),
      ...translator.translate({ type: 'end', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
    ];
    const final = events.find((event) => event.type === 'final_text');
    expect(final).toEqual({ type: 'final_text', content: 'before the tool\n\nafter' });
  });

  it('does not deliver Claude/Codex text deltas that were already streamed', () => {
    const handle = { interrupted: true, stopRequest: { type: 'user-stop' as const } };
    expect(shouldDeliverAgentEvent(handle, { type: 'text', delta: 'already shown' })).toBe(false);
    expect(shouldDeliverAgentEvent(handle, { type: 'final_text', content: 'held answer' })).toBe(true);
    const state = cardAfterStop(
      [
        { type: 'text', delta: 'already shown' },
        { type: 'final_text', content: 'held answer' },
        { type: 'done', terminationReason: 'interrupted' },
      ],
      { type: 'user-stop' },
    );
    const card = JSON.stringify(renderCard(state));
    expect(card).toContain('held answer');
    expect(card).not.toContain('already shown');
  });
});
