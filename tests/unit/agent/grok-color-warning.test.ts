import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import { reduce, seedRunState } from '../../../src/card/run-state';
import { renderCard } from '../../../src/card/run-renderer';

const FIXTURE = new URL('../../fixtures/grok/s2-color.jsonl', import.meta.url);

describe('Grok tool cards drop the Node NO_COLOR warning', () => {
  it('keeps RED and drops the warning and escape bytes', () => {
    const translator = new GrokJsonlTranslator();
    const events = readFileSync(FIXTURE, 'utf8')
      .trim()
      .split('\n')
      .flatMap((line) => translator.translate(JSON.parse(line) as unknown));
    const output = events.find((event) => event.type === 'tool_result');
    expect(output?.type).toBe('tool_result');
    if (output?.type !== 'tool_result') return;
    expect(output.output).toContain('RED');
    expect(output.output).toContain('YELLOWERR');
    expect(output.output).not.toContain("NO_COLOR' env is ignored");
    expect(output.output).not.toContain('\u001b');

    let state = seedRunState({});
    for (const event of events) state = reduce(state, event);
    const card = JSON.stringify(renderCard(state));
    expect(card).toContain('RED');
    expect(card).not.toContain("NO_COLOR' env is ignored");
    expect(card).not.toContain('\\u001b');
    expect(card).not.toContain('\u001b');
  });
});
