import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';

const FIXTURE = new URL('../../fixtures/grok/s1-read-usage.jsonl', import.meta.url);

describe('Grok ReadFile output and usage', () => {
  it('shows FileContent and emits the end usage once, including cost', () => {
    const translator = new GrokJsonlTranslator();
    const events = readFileSync(FIXTURE, 'utf8')
      .trim()
      .split('\n')
      .flatMap((line) => translator.translate(JSON.parse(line) as unknown));
    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toEqual({
      type: 'tool_result',
      id: 'call_read',
      output: '1→audit-note\nline-two\n',
      isError: false,
    });
    const usages = events.filter((event) => event.type === 'usage');
    expect(usages).toEqual([
      {
        type: 'usage',
        inputTokens: 22276,
        outputTokens: 466,
        cachedInputTokens: 27264,
        reasoningOutputTokens: 303,
        costUsd: 0.06098,
      },
    ]);
    expect(events.filter((event) => event.type === 'final_text')).toEqual([
      { type: 'final_text', content: 'AUDIT_DONE' },
    ]);
  });
});
