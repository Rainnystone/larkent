import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { grokMetadata } from '../../../src/agent/grok/metadata';
import { grokStderrSignatures } from '../../../src/agent/grok/stderr-signatures';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import { cardUserMessage } from '../../../src/agent/cli-signatures';
import { deriveRunOutcome } from '../../../src/bot/run-outcome';
import { reduce, seedRunState } from '../../../src/card/run-state';
import { FOLLOW_DEFAULT } from '../../../src/agent/definition';

const FIXTURE = new URL('../../fixtures/grok/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE), 'utf8');
}

describe('grok model catalog', () => {
  it('lists only model ids grok models reported, including the default', () => {
    const listed = fixture('models.txt');
    const ids = listed
      .split('\n')
      .map((line) => line.replace(/^[*\-\s]+/, '').trim())
      .map((line) => line.replace(/\s+\(default\)$/, ''))
      .filter((line) => line.startsWith('grok-'));
    expect(ids).toContain('grok-4.7');
    for (const model of grokMetadata.models) {
      if (model.value === FOLLOW_DEFAULT.value) continue;
      expect(ids, model.value).toContain(model.value);
    }
    expect(grokMetadata.models.map((model) => model.value)).not.toContain('grok-build');
  });

  it('keeps the unknown-model reason on the card and does not offer a retry', () => {
    const line = JSON.parse(fixture('s5-bad-model.jsonl')) as unknown;
    const events = new GrokJsonlTranslator().translate(line);
    const error = events.find((event) => event.type === 'error');
    expect(error?.type).toBe('error');
    if (error?.type !== 'error') return;
    const outcome = deriveRunOutcome({
      terminalEvent: error,
      stderrTail: error.message,
      signatures: grokStderrSignatures,
    });
    expect(outcome).toMatchObject({ kind: 'failed', retriable: false });
    const message = cardUserMessage(outcome, grokStderrSignatures.find((sig) => sig.pattern.test(error.message)));
    let state = reduce(seedRunState({}), error);
    if (message) state = { ...state, errorMsg: message };
    expect(state.errorMsg).toContain('unknown model id');
    expect(JSON.stringify(state)).not.toContain('agent 运行失败');
  });
});
