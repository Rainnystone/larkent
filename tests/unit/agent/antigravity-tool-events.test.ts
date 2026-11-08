import { describe, expect, it } from 'vitest';
import { inspectAutomationToolUse } from '../../../src/automations/policy-guard';
import { AntigravityJsonlTranslator } from '../../../src/agent/antigravity/jsonl';
import type { AgentEvent } from '../../../src/agent/types';
import { replay, transcriptCase } from '../../helpers/transcript-replay';

const CONVERSATION = '<SESSION_1>';

function collect(translator: AntigravityJsonlTranslator, lines: unknown[]): AgentEvent[] {
  return lines.flatMap((line) => translator.translate(line));
}

function toolEvents(
  events: AgentEvent[],
): Array<Extract<AgentEvent, { type: 'tool_use' | 'tool_result' }>> {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: 'tool_use' | 'tool_result' }> => (
      event.type === 'tool_use' || event.type === 'tool_result'
    ),
  );
}

describe('agy tool pairing from real 1.4.8 captures', () => {
  it('pairs long-tool ACTIVE/DONE by conversation_id and step_index', () => {
    const events = toolEvents(replay(transcriptCase('antigravity', 'long-tool')));
    expect(events.map((event) => event.type)).toEqual(['tool_use', 'tool_result']);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'tool_use',
      id: `${CONVERSATION}:2`,
      name: 'run_command',
    }));
    expect(events[1]).toEqual(expect.objectContaining({
      type: 'tool_result',
      id: `${CONVERSATION}:2`,
      isError: false,
    }));
    const use = events[0];
    if (use?.type !== 'tool_use') throw new Error('expected tool_use');
    expect(inspectAutomationToolUse(use)).toBeUndefined();
  });

  it('keeps two sequential tools on distinct step indices', () => {
    const events = toolEvents(replay(transcriptCase('antigravity', 'two-tools')));
    expect(events.map((event) => event.type)).toEqual([
      'tool_use', 'tool_result', 'tool_use', 'tool_result',
    ]);
    expect(events.map((event) => event.id)).toEqual([
      `${CONVERSATION}:2`,
      `${CONVERSATION}:2`,
      `${CONVERSATION}:4`,
      `${CONVERSATION}:4`,
    ]);
  });

  it('does not treat a checkpoint ping as a tool start', () => {
    const t = new AntigravityJsonlTranslator();
    const events = collect(t, [
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv',
          step_index: 3,
          state: 'DONE',
          step_type: 'checkpoint',
        },
      },
    ]);
    expect(toolEvents(events)).toEqual([]);
    expect(events).toEqual([{ type: 'liveness' }]);
  });

  it('opens tool grace from ACTIVE CommandLine without skipping policy-guard', () => {
    const t = new AntigravityJsonlTranslator();
    const events = toolEvents(collect(t, [
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv',
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: {
            name: 'run_command',
            parameters: { CommandLine: 'lark-cli auth login' },
          },
        },
      },
    ]));
    expect(events).toEqual([
      {
        type: 'tool_use',
        id: 'conv:1',
        name: 'run_command',
        input: { CommandLine: 'lark-cli auth login', command: 'lark-cli auth login' },
      },
    ]);
    const use = events[0];
    if (use?.type !== 'tool_use') throw new Error('expected tool_use');
    expect(inspectAutomationToolUse(use)).toEqual({ reason: 'auth-config' });
  });

  it('does not close a sibling sub-agent tool that reused step_index', () => {
    const t = new AntigravityJsonlTranslator();
    const events = toolEvents(collect(t, [
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv',
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'grep_search',
          subagent_info: { name: 'explore' },
          tool_info: { name: 'grep_search', parameters: { query: 'a' } },
        },
      },
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv',
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'grep_search',
          subagent_info: { name: 'review' },
          tool_info: { name: 'grep_search', parameters: { query: 'b' } },
        },
      },
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv',
          step_index: 2,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'grep_search',
          subagent_info: { name: 'explore' },
          tool_info: { name: 'grep_search', output: 'a' },
        },
      },
    ]));
    expect(events.map((event) => ({ type: event.type, id: event.id }))).toEqual([
      { type: 'tool_use', id: 'conv:2:explore' },
      { type: 'tool_use', id: 'conv:2:review' },
      { type: 'tool_result', id: 'conv:2:explore' },
    ]);
  });
});
