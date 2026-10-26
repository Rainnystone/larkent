import { describe, expect, it } from 'vitest';
import { CodexJsonlTranslator } from '../../../src/agent/codex/jsonl';
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

const stops: StopRequest[] = [
  { type: 'user-stop' },
  ...(['new', 'cd', 'ws', 'resume'] as const).map(by => ({ type: 'superseded' as const, by })),
  { type: 'reconnect-command' }, { type: 'account-restart' }, { type: 'shutdown-signal' },
  { type: 'exit-command' }, { type: 'bridge-idle-watchdog' }, { type: 'runner-timeout' },
  { type: 'meeting' }, { type: 'subscriber-abandoned' }, { type: 'external-signal' },
  { type: 'policy-guard', code: 'auth-config' },
];

describe('buffered answers after stop', () => {
  it.each(stops.flatMap(stop => (['grok', 'codex'] as const).map(cli => ({ cli, stop }))))(
    '$cli delivers a buffered answer only for explicit user stop: $stop', ({ cli, stop }) => {
      const translator = cli === 'grok' ? new GrokJsonlTranslator() : new CodexJsonlTranslator();
      translator.translate(cli === 'grok'
        ? { type: 'text', data: 'BUFFERED_ANSWER' }
        : { type: 'item.completed', item: { type: 'agent_message', text: 'BUFFERED_ANSWER' } });
      const events = [...translator.finish('interrupted'), ...translator.finish('interrupted')];
      const card = JSON.stringify(renderCard(cardAfterStop(events, stop)));
      expect(card.split('BUFFERED_ANSWER').length - 1).toBe(stop.type === 'user-stop' ? 1 : 0);
    },
  );

  it('delivers held text as the card answer after a user stop', () => {
    const card = stoppedAnswer(['answer ', 'before stop'], { type: 'user-stop' });
    expect(card).toContain('answer before stop');
  });

  it('shows text that arrived before a tool call as progress, not as the answer', () => {
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
    const progress = events.filter((event) => event.type === 'text');
    expect(progress).toEqual([{ type: 'text', delta: 'before the tool\n\n' }]);
    const final = events.find((event) => event.type === 'final_text');
    expect(final).toEqual({ type: 'final_text', content: 'after' });
  });

  it('answers with the last pre-tool text after a user stop with no text after the tool', () => {
    const translator = new GrokJsonlTranslator();
    translator.translate({ type: 'text', data: 'checking the file' });
    translator.translate({
      type: 'tool_call',
      toolCallId: 'call_1',
      toolName: 'read_file',
      status: 'in_progress',
      rawInput: { path: 'a.ts' },
    });
    const events = translator.finish('interrupted');
    expect(events.find((event) => event.type === 'final_text')).toEqual({
      type: 'final_text',
      content: 'checking the file',
    });
    const card = JSON.stringify(renderCard(cardAfterStop(events, { type: 'user-stop' })));
    expect(card).toContain('checking the file');
  });

  it('suppresses text deltas after a user stop while retaining the buffered final answer', () => {
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
