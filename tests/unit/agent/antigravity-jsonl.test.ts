import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityJsonlTranslator } from '../../../src/agent/antigravity/jsonl';
import type { AgentEvent } from '../../../src/agent/types';
import { finalAnswerOnlyState } from '../../../src/bot/cot';
import { initialState, reduce } from '../../../src/card/run-state';
import { renderText } from '../../../src/card/text-renderer';
import { log } from '../../../src/core/logger';
import {
  INCIDENT_A_ENVELOPE,
  INCIDENT_A_MESSAGE_ID,
  INCIDENT_A_PROSE,
  matrixRow,
} from '../../fixtures/antigravity/envelope-classifier-matrix';

const CONVERSATION = 'f8c7af3a-4080-4505-981e-87dc09f7f50e';
const TOOL_CHECKPOINT_FIXTURE = join(
  process.cwd(),
  'tests/fixtures/antigravity/tool-checkpoint-steps.jsonl',
);
const EMPTY_SUCCESS_PRINT_TIMEOUT_FIXTURE = join(
  process.cwd(),
  'tests/fixtures/antigravity/empty-success-print-timeout.jsonl',
);
const SYSTEM_MESSAGE_ENVELOPE_INCIDENT_FIXTURE = join(
  process.cwd(),
  'tests/fixtures/antigravity/system-message-envelope-incident.jsonl',
);
const PRINT_TIMEOUT_HINT = 'Antigravity print-timeout reached before a reply was produced.';
const IDLE_WATCHDOG_COPY = '分钟无响应';
const INCIDENT_PROSE = INCIDENT_A_PROSE;
const INCIDENT_ENVELOPE = INCIDENT_A_ENVELOPE;

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('scrubs a SYSTEM_MESSAGE envelope prepended to incident prose from result.response', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, loadJsonl(SYSTEM_MESSAGE_ENVELOPE_INCIDENT_FIXTURE));
    expect(events.find((event) => event.type === 'final_text')).toEqual({
      type: 'final_text',
      content: INCIDENT_PROSE,
    });
    expect(events.filter((event) => event.type === 'final_text')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('<SYSTEM_MESSAGE');
    expect(projectedRenderText(events)).toContain(INCIDENT_PROSE);
    expect(projectedRenderText(events)).not.toContain('<SYSTEM_MESSAGE');
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 0 });
  });

  it('leaves a clean SUCCESS reply byte-identical when no envelope is present', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
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
  });

  it('C2: treats envelope-only SUCCESS as empty so existing skip-empty rules apply', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: `${INCIDENT_ENVELOPE}\n`,
        },
      },
    ]);
    expect(events).toEqual([
      { type: 'system', resumeHandle: CONVERSATION },
      { type: 'done', resumeHandle: CONVERSATION, terminationReason: 'normal' },
    ]);
    expect(projectedRenderText(events).trim()).toBe('');
  });

  it('C2: falls through to the print-timeout hint when envelope-only SUCCESS follows tools', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      ...loadJsonl(TOOL_CHECKPOINT_FIXTURE),
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: INCIDENT_ENVELOPE,
        },
      },
    ]);
    expect(events.find((event) => event.type === 'final_text')).toEqual({
      type: 'final_text',
      content: PRINT_TIMEOUT_HINT,
    });
    expect(JSON.stringify(events)).not.toContain('<SYSTEM_MESSAGE');
  });

  it('scrubs held-back agent_response text flushed through prependHeldBack', () => {
    const t = new AntigravityJsonlTranslator();
    collect(t, [
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: `${INCIDENT_ENVELOPE}\n${INCIDENT_PROSE}\n`,
        },
      },
    ]);
    expect(t.fail('agy exited with code 1')).toEqual([
      { type: 'system', resumeHandle: CONVERSATION },
      { type: 'final_text', content: INCIDENT_PROSE },
      { type: 'error', message: 'agy exited with code 1', terminationReason: 'failed' },
    ]);
  });

  it('B4: keeps an unclosed non-fingerprinted opener and trailing prose byte-identical', () => {
    const row = matrixRow('B4');
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: `${INCIDENT_ENVELOPE}\n前半段\n<SYSTEM_MESSAGE>mid</SYSTEM_MESSAGE>\n后半段\n${row.input}`,
        },
      },
    ]);
    expect(events.find((event) => event.type === 'final_text')).toEqual({
      type: 'final_text',
      content: `前半段\n\n后半段\n${row.input}`,
    });
  });

  it.each(['B1', 'B2', 'B3', 'B5'] as const)(
    '%s: translateResult leaves citation or stray closer byte-identical',
    (id) => {
      const row = matrixRow(id);
      const t = new AntigravityJsonlTranslator();
      const events = collect(t, [
        INIT,
        {
          event: 'result',
          result: {
            conversation_id: CONVERSATION,
            status: 'SUCCESS',
            response: row.input,
          },
        },
      ]);
      expect(events.find((event) => event.type === 'final_text')).toEqual({
        type: 'final_text',
        content: row.expectedText,
      });
    },
  );

  it('A3: strips an unclosed fingerprinted envelope through end on result.response', () => {
    const row = matrixRow('A3');
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: row.input,
        },
      },
    ]);
    expect(events.filter((event) => event.type === 'final_text')).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('[Message]');
    expect(JSON.stringify(events)).not.toContain('truncated envelope body that must not leak');
  });

  it('A4: removes the preamble companion with the envelope on result.response', () => {
    const row = matrixRow('A4');
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: row.input,
        },
      },
    ]);
    expect(events.find((event) => event.type === 'final_text')).toEqual({
      type: 'final_text',
      content: row.expectedText,
    });
    expect(JSON.stringify(events)).not.toContain('The following is a');
  });

  it('C1: first closer wins on nested-looking opens without a depth matcher', () => {
    const row = matrixRow('C1');
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: row.input,
        },
      },
    ]);
    expect(events.find((event) => event.type === 'final_text')).toEqual({
      type: 'final_text',
      content: row.expectedText,
    });
  });

  it('A2: scrubs the Incident A envelope shape cited by om_x100b65e6a11b3cb4b10254b74b00974', () => {
    expect(INCIDENT_A_MESSAGE_ID).toBe('om_x100b65e6a11b3cb4b10254b74b00974');
    const row = matrixRow('A2');
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: row.input,
        },
      },
    ]);
    expect(events.find((event) => event.type === 'final_text')).toEqual({
      type: 'final_text',
      content: row.expectedText,
    });
  });

  it('B4: prependHeldBack leaves a vitest-title unclosed opener byte-identical', () => {
    const row = matrixRow('B4');
    const t = new AntigravityJsonlTranslator();
    collect(t, [
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: row.input,
        },
      },
    ]);
    expect(t.fail('agy exited with code 1')).toEqual([
      { type: 'system', resumeHandle: CONVERSATION },
      { type: 'final_text', content: row.input },
      { type: 'error', message: 'agy exited with code 1', terminationReason: 'failed' },
    ]);
  });

  it('A1: prependHeldBack strips a fingerprinted envelope and keeps the prose', () => {
    const row = matrixRow('A1');
    const t = new AntigravityJsonlTranslator();
    collect(t, [
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: row.input,
        },
      },
    ]);
    expect(t.fail('agy exited with code 1')).toEqual([
      { type: 'system', resumeHandle: CONVERSATION },
      { type: 'final_text', content: row.expectedText },
      { type: 'error', message: 'agy exited with code 1', terminationReason: 'failed' },
    ]);
  });

  it('C3: does not rewrite ERROR results that mention SYSTEM_MESSAGE in the error text', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'ERROR',
          response: `${INCIDENT_ENVELOPE}\n${INCIDENT_PROSE}`,
          error: `FAILED_PRECONDITION: leaked ${INCIDENT_ENVELOPE}`,
        },
      },
    ]);
    expect(events.filter((event) => event.type === 'final_text')).toEqual([]);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      {
        type: 'error',
        message: `FAILED_PRECONDITION: leaked ${INCIDENT_ENVELOPE}`,
        terminationReason: 'failed',
      },
    ]);
  });

  it('C3: does not rewrite FAILED results that mention SYSTEM_MESSAGE in the error text', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      INIT,
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'FAILED',
          response: `${INCIDENT_ENVELOPE}\n${INCIDENT_PROSE}`,
          error: `FAILED: leaked ${INCIDENT_ENVELOPE}`,
        },
      },
    ]);
    expect(events.filter((event) => event.type === 'final_text')).toEqual([]);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      {
        type: 'error',
        message: `FAILED: leaked ${INCIDENT_ENVELOPE}`,
        terminationReason: 'failed',
      },
    ]);
  });

  it('T1: logs scrub lengths plus classifier fields and never logs the body', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const row = matrixRow('T1');
    const t = new AntigravityJsonlTranslator();
    collect(t, [
      INIT,
      {
        event: 'step_update',
        step_update: {
          conversation_id: CONVERSATION,
          step_index: 1,
          state: 'DONE',
          step_type: 'system_message',
        },
      },
      {
        event: 'result',
        result: {
          conversation_id: CONVERSATION,
          status: 'SUCCESS',
          response: row.input,
        },
      },
    ]);
    expect(info.mock.calls).toEqual([
      [
        'jsonl',
        'system_message_scrubbed',
        {
          beforeLength: row.input.length,
          afterLength: row.expectedText.length,
          removedCount: 1,
          unclosed: false,
          preambleRemoved: false,
          sawSystemMessageStep: true,
        },
      ],
      ['jsonl', 'system_message_tag_retained', { reason: 'mid-line' }],
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toContain('<SYSTEM_MESSAGE');
    expect(JSON.stringify(info.mock.calls)).not.toContain(INCIDENT_PROSE);
    expect(JSON.stringify(info.mock.calls)).not.toContain('[Message]');
  });

  it.each(['B1', 'B2', 'B3', 'B4'] as const)(
    'T1: logs system_message_tag_retained with the %s reason and never the body',
    (id) => {
      const row = matrixRow(id);
      const info = vi.spyOn(log, 'info').mockImplementation(() => {});
      const t = new AntigravityJsonlTranslator();
      collect(t, [
        INIT,
        {
          event: 'result',
          result: {
            conversation_id: CONVERSATION,
            status: 'SUCCESS',
            response: row.input,
          },
        },
      ]);
      const retained = info.mock.calls.filter(
        (call) => call[0] === 'jsonl' && call[1] === 'system_message_tag_retained',
      );
      expect(retained.map((call) => call[2])).toEqual(
        row.retainedReasons.map((reason) => ({ reason })),
      );
      expect(JSON.stringify(info.mock.calls)).not.toContain(row.input);
    },
  );
});
