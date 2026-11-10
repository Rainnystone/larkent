import { describe, expect, it } from 'vitest';
import { replay, transcriptCase, type ReplayKind } from '../../helpers/transcript-replay';

describe('activity in D03a captures without renderable text', () => {
  it.each([
    ['codex', 'turn.started', undefined, { type: 'liveness' }],
    ['kimi', 'system.version', undefined, { type: 'liveness' }],
    ['grok', 'tool_call_update', 'in_progress', { type: 'liveness' }],
    ['cursor', 'thinking', undefined, { type: 'liveness' }],
    ['antigravity', 'tool', undefined, { type: 'tool_use', name: 'run_command' }],
    ['devin', 'tool_call_update', 'in_progress', { type: 'liveness' }],
  ] as const)('%s reports captured activity', (kind, type, status, expected) => {
    const entry = transcriptCase(kind, 'narration-tool-answer');
    const step = entry.steps.find(step => {
      const raw = step.args[0] as Record<string, unknown>;
      if (step.method !== 'translate') return false;
      const nested = raw.step_update as Record<string, unknown> | undefined;
      return (raw.type === type || raw.sessionUpdate === type || nested?.step_type === type)
        && (status === undefined || raw.status === status);
    });
    expect(step, `D03a ${kind} must contain the cited activity`).toBeDefined();
    expect(replay({ kind: kind as ReplayKind, name: 'activity', source: entry.source, steps: [step!] })).toContainEqual(
      expect.objectContaining(expected),
    );
  });
});
