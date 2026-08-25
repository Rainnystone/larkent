import { describe, expect, it } from 'vitest';
import { buildGrokArgs } from '../../../src/agent/grok/argv';

describe('buildGrokArgs', () => {
  it('builds a fresh headless invocation with streaming-json and unattended flags', () => {
    expect(buildGrokArgs({ prompt: 'hello', rules: 'be the bot' })).toEqual([
      '-p',
      'hello',
      '--output-format',
      'streaming-json',
      '--rules',
      'be the bot',
      '--always-approve',
      '--no-auto-update',
    ]);
  });

  it('resumes with -r and never uses -s', () => {
    const args = buildGrokArgs({
      prompt: 'continue',
      rules: 'rules',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      model: 'grok-build',
    });
    expect(args).toEqual([
      '-p',
      'continue',
      '--output-format',
      'streaming-json',
      '--rules',
      'rules',
      '--always-approve',
      '--no-auto-update',
      '-r',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '-m',
      'grok-build',
    ]);
    expect(args).not.toContain('-s');
    expect(args).not.toContain('--session-id');
  });

  it('keeps the prompt and rules as single argv elements', () => {
    const prompt = '<bridge_context>{"chatId":"oc_1"}</bridge_context>\n\nhello > world';
    const rules = 'rule one\nrule two';
    const args = buildGrokArgs({ prompt, rules });
    expect(args[1]).toBe(prompt);
    expect(args[args.indexOf('--rules') + 1]).toBe(rules);
  });
});
