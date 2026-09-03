import { describe, expect, it } from 'vitest';
import { buildCursorArgs } from '../../../src/agent/cursor/argv';

describe('buildCursorArgs', () => {
  it('builds a fresh print-mode invocation with unattended flags', () => {
    expect(buildCursorArgs({ prompt: 'hello' })).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--force',
      '--sandbox',
      'disabled',
      '--approve-mcps',
      '--trust',
      'hello',
    ]);
  });

  it('appends --resume and --model before the positional prompt', () => {
    expect(
      buildCursorArgs({
        prompt: 'continue',
        sessionId: 'c6b62c6f-7ead-4fd6-9922-e952131177ff',
        model: 'composer-2.5',
      }),
    ).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--force',
      '--sandbox',
      'disabled',
      '--approve-mcps',
      '--trust',
      '--resume',
      'c6b62c6f-7ead-4fd6-9922-e952131177ff',
      '--model',
      'composer-2.5',
      'continue',
    ]);
  });

  it('keeps the prompt as a single argv element even with XML-ish content', () => {
    const prompt = '<bridge_context>{"chatId":"oc_1"}</bridge_context>\n\nhello > world';
    const args = buildCursorArgs({ prompt });
    expect(args.at(-1)).toBe(prompt);
  });

  it('rejects restricted sandbox modes instead of silently disabling Cursor sandbox', () => {
    expect(() => buildCursorArgs({ prompt: 'hi', sandbox: 'read-only' })).toThrow(
      /only supports full access/,
    );
    expect(() => buildCursorArgs({ prompt: 'hi', sandbox: 'workspace-write' })).toThrow(
      /only supports full access/,
    );
    expect(() => buildCursorArgs({ prompt: 'hi', sandbox: 'danger-full-access' })).not.toThrow();
  });
});
