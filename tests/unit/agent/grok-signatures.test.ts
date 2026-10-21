import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cardUserMessage, matchCliSignature } from '../../../src/agent/cli-signatures';
import { grokStderrSignatures } from '../../../src/agent/grok/stderr-signatures';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import { planInterruptionNotice } from '../../../src/bot/interruption-notice';
import { deriveRunOutcome } from '../../../src/bot/run-outcome';
import type { AgentEvent } from '../../../src/agent/types';

const FIXTURE = new URL('../../fixtures/grok/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE), 'utf8');
}

function classify(stderrTail: string, terminalEvent?: AgentEvent) {
  const signature = matchCliSignature(stderrTail, grokStderrSignatures);
  const outcome = deriveRunOutcome({
    terminalEvent: terminalEvent ?? {
      type: 'error',
      message: stderrTail,
      terminationReason: 'failed',
    },
    stderrTail,
    signatures: grokStderrSignatures,
    exit: 1,
  });
  return { signature, outcome, message: cardUserMessage(outcome, signature) };
}

describe('Grok failure signatures', () => {
  it.each(['404 Not Found', 'GET /synthetic/resource: 404 Not Found'])('does not classify an unrelated 404 as a missing session: %s', stderr => {
    const { signature, outcome, message } = classify(stderr);
    expect(signature).toBeUndefined();
    expect(outcome).toMatchObject({ kind: 'failed', retriable: true });
    expect(message).toBe('agent 运行失败');
  });

  it('retains the specific session get failed: 404 signature', () => {
    const { outcome, message } = classify('Error: session get failed: 404 Not Found');
    expect(outcome).toMatchObject({ kind: 'failed', retriable: false, needsHuman: true });
    expect(message).toContain('会话不存在');
  });

  it('treats a 404 resume as a non-retriable failure without a continue notice', () => {
    const stderr = fixture('s4-bad-session.err');
    const { outcome, message } = classify(stderr);
    expect(outcome).toMatchObject({ kind: 'failed', retriable: false });
    expect(message).toContain('404');
    expect(message).not.toBe('agent 运行失败');
    expect(planInterruptionNotice(outcome).kind).not.toBe('continue');
  });

  it('treats an unknown model as a non-retriable failure without a continue notice', () => {
    const line = JSON.parse(fixture('s5-bad-model.jsonl')) as unknown;
    const events = new GrokJsonlTranslator().translate(line);
    const error = events.find((event) => event.type === 'error');
    expect(error?.type).toBe('error');
    if (error?.type !== 'error') return;
    const { outcome, message } = classify(error.message, error);
    expect(outcome).toMatchObject({ kind: 'failed', retriable: false });
    expect(message).toContain('unknown model id');
    expect(message).not.toBe('agent 运行失败');
    expect(planInterruptionNotice(outcome).kind).not.toBe('continue');
  });

  it('treats a missing directory session as a non-retriable failure', () => {
    const stderr = fixture('s6-no-session.err');
    const { outcome, message } = classify(stderr);
    expect(outcome).toMatchObject({ kind: 'failed', retriable: false });
    expect(message).toContain('No session found for current directory');
    expect(planInterruptionNotice(outcome).kind).not.toBe('continue');
  });
});
