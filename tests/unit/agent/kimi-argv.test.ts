import { describe, expect, it } from 'vitest';
import { buildKimiArgs } from '../../../src/agent/kimi/argv';

describe('buildKimiArgs', () => {
  it('builds a fresh print-mode invocation with stream-json output', () => {
    expect(buildKimiArgs({ prompt: 'hello' })).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
    ]);
  });

  it('appends session resume and model flags', () => {
    expect(
      buildKimiArgs({ prompt: 'continue', sessionId: 'session_abc', model: 'kimi-code/kimi-for-coding' }),
    ).toEqual([
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '-S',
      'session_abc',
      '-m',
      'kimi-code/kimi-for-coding',
    ]);
  });

  it('keeps the prompt as a single argv element even with XML-ish content', () => {
    const prompt = '<bridge_context>{"chatId":"oc_1"}</bridge_context>\n\nhello > world';
    const args = buildKimiArgs({ prompt });
    expect(args[1]).toBe(prompt);
  });
});
