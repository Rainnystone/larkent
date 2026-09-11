import { describe, expect, it } from 'vitest';
import { AntigravityJsonlTranslator } from '../../../src/agent/antigravity/jsonl';
import type { AgentEvent } from '../../../src/agent/types';

const CONVERSATION = 'f8c7af3a-4080-4505-981e-87dc09f7f50e';

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

  it('ignores unknown events and step types without throwing', () => {
    const t = new AntigravityJsonlTranslator();
    expect(
      collect(t, [
        { event: 'step_update', step_update: { step_type: 'system_message', state: 'DONE' } },
        { event: 'not-a-real-event' },
      ]),
    ).toEqual([]);
    expect(t.protocolDrift().unknownEvents).toBe(1);
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
