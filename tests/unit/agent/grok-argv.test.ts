import { describe, expect, it } from 'vitest';
import { buildGrokArgs } from '../../../src/agent/grok/argv';

describe('buildGrokArgs', () => {
  it('builds a fresh headless invocation with streaming-json and unattended flags', () => {
    expect(buildGrokArgs({ promptFile: '/tmp/prompt.txt', rules: 'be the bot' })).toEqual([
      '--prompt-file',
      '/tmp/prompt.txt',
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
      promptFile: '/tmp/prompt.txt',
      rules: 'rules',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      model: 'grok-build',
    });
    expect(args).toEqual([
      '--prompt-file',
      '/tmp/prompt.txt',
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

  it('keeps rules as one argv element and does not put the prompt text on argv', () => {
    const prompt = 'bridge context hello > world';
    const rules = 'rule one\nrule two';
    const args = buildGrokArgs({ promptFile: '/tmp/prompt.txt', rules });
    expect(args).not.toContain(prompt);
    expect(args).not.toContain('-p');
    expect(args[args.indexOf('--rules') + 1]).toBe(rules);
  });
});
