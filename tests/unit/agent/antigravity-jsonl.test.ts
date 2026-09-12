import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AntigravityJsonlTranslator } from '../../../src/agent/antigravity/jsonl';
import type { AgentEvent } from '../../../src/agent/types';
import { finalAnswerOnlyState } from '../../../src/bot/cot';
import { initialState, reduce } from '../../../src/card/run-state';
import { renderText } from '../../../src/card/text-renderer';

const CONVERSATION = 'f8c7af3a-4080-4505-981e-87dc09f7f50e';
const TOOL_CHECKPOINT_FIXTURE = join(
  process.cwd(),
  'tests/fixtures/antigravity/tool-checkpoint-steps.jsonl',
);
const EMPTY_SUCCESS_PRINT_TIMEOUT_FIXTURE = join(
  process.cwd(),
  'tests/fixtures/antigravity/empty-success-print-timeout.jsonl',
);
const PRINT_TIMEOUT_HINT = 'Antigravity print-timeout reached before a reply was produced.';
const IDLE_WATCHDOG_COPY = '分钟无响应';

function loadJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

const INIT = {
  event: 'init',
  conversation_id: CONVERSATION,
  init: {
    model: 'claude-sonnet-4-6',
    cwd: '/tmp',
    tools: ['view_file'],
    permission_mode: 'always-proceed',
  },
};

function collect(translator: AntigravityJsonlTranslator, lines: unknown[]): AgentEvent[] {
  return lines.flatMap((line) => translator.translate(line));
}

function projectedRenderText(events: AgentEvent[]): string {
  const state = events.reduce((next, event) => reduce(next, event), initialState);
  return renderText(finalAnswerOnlyState(state));
}

describe('AntigravityJsonlTranslator', () => {
  it('maps a captured print-mode success stream to system + final_text + done', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 0,
          state: 'DONE',
          step_type: 'user_input',
        },
      },
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'pong\n',
          duration_seconds: 4.381362,
          usage: {
            input_tokens: 19469,
            output_tokens: 15,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 19484,
          },
        },
      },
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: 'pong\n',
          duration_seconds: 4.415612,
          num_turns: 1,
          usage: {
            input_tokens: 19469,
            output_tokens: 15,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 19484,
          },
        },
      },
    ]);
    expect(events).toEqual([
      { type: 'system', resumeHandle: CONVERSATION },
      {
        type: 'usage',
        inputTokens: 19469,
        outputTokens: 15,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      },
      { type: 'final_text', content: 'pong\n' },
      { type: 'done', resumeHandle: CONVERSATION, terminationReason: 'normal' },
    ]);
    expect(t.terminalEmitted()).toBe(true);
  });

  it('prefers result.response over concatenated text_delta fragments', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 4,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'ping',
        },
      },
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 4,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: '\n',
        },
      },
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: 'ping\n',
        },
      },
    ]);
    expect(events.find((e) => e.type === 'final_text')).toEqual({
      type: 'final_text',
      content: 'ping\n',
    });
    expect(events.filter((e) => e.type === 'text')).toEqual([]);
  });

  it('maps result ERROR to a terminal error and not a successful empty reply', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 2,
          state: 'DONE',
          step_type: 'error_message',
        },
      },
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'ERROR',
          response: '',
          error: 'FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 0,
          },
        },
      },
    ]);
    expect(events.filter((e) => e.type === 'final_text')).toEqual([]);
    expect(events.filter((e) => e.type === 'error')).toEqual([
      {
        type: 'error',
        message: 'FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
        terminationReason: 'failed',
      },
    ]);
    expect(t.terminalEmitted()).toBe(true);
  });

  it('recognizes official tool and checkpoint steps without tool events or drift', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, loadJsonl(TOOL_CHECKPOINT_FIXTURE));
    expect(events).toEqual([{ type: 'system', resumeHandle: CONVERSATION }]);
    expect(events.filter((e) => e.type === 'tool_use' || e.type === 'tool_result')).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 0 });
  });

  it('keeps already-silent official steps from incrementing drift', () => {
    const t = new AntigravityJsonlTranslator();
    expect(
      collect(t, [
        { event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE' } },
        { event: 'step_update', step_update: { step_type: 'system_message', state: 'DONE' } },
        { event: 'step_update', step_update: { step_type: 'error_message', state: 'DONE' } },
      ]),
    ).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 0 });
  });

  it('ignores unknown events and step types without throwing', () => {
    const t = new AntigravityJsonlTranslator();
    expect(
      collect(t, [
        { event: 'step_update', step_update: { step_type: 'system_message', state: 'DONE' } },
        { event: 'step_update', step_update: { step_type: 'not_a_real_step', state: 'DONE' } },
        { event: 'not-a-real-event' },
      ]),
    ).toEqual([]);
    expect(t.protocolDrift().unknownEvents).toBe(2);
  });

  it('finish(failed) surfaces an error when the stream had no result', () => {
    const t = new AntigravityJsonlTranslator();
    expect(t.finish()).toEqual([
      {
        type: 'error',
        message: 'antigravity stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
  });

  it('fail() flushes held-back reply text and a resume handle from step_update', () => {
    const t = new AntigravityJsonlTranslator();
    expect(
      collect(t, [
        {
          event: 'step_update',
          step_update: {
            conversation_id: CONVERSATION,
            step_index: 1,
            state: 'ACTIVE',
            step_type: 'agent_response',
            text_delta: 'partial answer',
          },
        },
      ]),
    ).toEqual([]);
    expect(t.fail('agy exited with code 1')).toEqual([
      { type: 'system', resumeHandle: CONVERSATION },
      { type: 'final_text', content: 'partial answer' },
      { type: 'error', message: 'agy exited with code 1', terminationReason: 'failed' },
    ]);
    expect(t.fail('again')).toEqual([]);
  });

  it('emits a print-timeout hint for the incident empty SUCCESS after tools and checkpoint', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, loadJsonl(EMPTY_SUCCESS_PRINT_TIMEOUT_FIXTURE));
    expect(events).toEqual([
      { type: 'system', resumeHandle: CONVERSATION },
      {
        type: 'usage',
        inputTokens: 19469,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      },
      { type: 'final_text', content: PRINT_TIMEOUT_HINT },
      { type: 'done', resumeHandle: CONVERSATION, terminationReason: 'normal' },
    ]);
    const body = projectedRenderText(events);
    expect(body.trim()).not.toBe('');
    expect(body).toContain('print-timeout');
    expect(body).not.toContain(IDLE_WATCHDOG_COPY);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 0 });
    expect(t.terminalEmitted()).toBe(true);
  });

  it('keeps a short clean empty SUCCESS silent so outbound may skip-empty', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 0,
          state: 'DONE',
          step_type: 'user_input',
        },
      },
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: '',
        },
      },
    ]);
    expect(events).toEqual([
      { type: 'system', resumeHandle: CONVERSATION },
      { type: 'done', resumeHandle: CONVERSATION, terminationReason: 'normal' },
    ]);
    expect(projectedRenderText(events).trim()).toBe('');
  });

  it('does not classify a SUCCESS with real response text as print-timeout', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      ...loadJsonl(TOOL_CHECKPOINT_FIXTURE),
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: 'pong\n',
        },
      },
    ]);
    expect(events.find((event) => event.type === 'final_text')).toEqual({
      type: 'final_text',
      content: 'pong\n',
    });
    expect(projectedRenderText(events)).toContain('pong');
    expect(projectedRenderText(events)).not.toContain('print-timeout');
  });

  it('flushes held-back agent_response text instead of a print-timeout hint', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      ...loadJsonl(TOOL_CHECKPOINT_FIXTURE),
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 4,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'partial answer\n',
        },
      },
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: '',
        },
      },
    ]);
    expect(events.find((event) => event.type === 'final_text')).toEqual({
      type: 'final_text',
      content: 'partial answer\n',
    });
    expect(projectedRenderText(events)).toContain('partial answer');
    expect(projectedRenderText(events)).not.toContain('print-timeout');
  });

  it('keeps FAILED results as terminal errors after recognized tools', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      ...loadJsonl(TOOL_CHECKPOINT_FIXTURE),
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'FAILED',
          response: '',
          error: 'timeout waiting for response',
        },
      },
    ]);
    expect(events.filter((event) => event.type === 'final_text')).toEqual([]);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      {
        type: 'error',
        message: 'timeout waiting for response',
        terminationReason: 'failed',
      },
    ]);
  });

  it('trusts an official result error field that means print-timeout', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: '',
          error: 'timeout waiting for response',
        },
      },
    ]);
    expect(events.find((event) => event.type === 'final_text')).toEqual({
      type: 'final_text',
      content: PRINT_TIMEOUT_HINT,
    });
    expect(events).toContainEqual({
      type: 'done',
      resumeHandle: CONVERSATION,
      terminationReason: 'normal',
    });
    expect(projectedRenderText(events).trim()).not.toBe('');
    expect(projectedRenderText(events)).not.toContain(IDLE_WATCHDOG_COPY);
  });

  it('finish(failed) flushes held-back reply text when the stream had no result', () => {
    const t = new AntigravityJsonlTranslator();
    collect(t, [
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'truncated\n',
        },
      },
    ]);
    expect(t.finish()).toEqual([
      { type: 'system', resumeHandle: CONVERSATION },
      { type: 'final_text', content: 'truncated\n' },
      {
        type: 'error',
        message: 'antigravity stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
  });
});
