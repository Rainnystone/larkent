import { describe, expect, it } from 'vitest';
import { buildAntigravityArgs } from '../../../src/agent/antigravity/argv';

describe('buildAntigravityArgs', () => {
  it('builds a fresh print-mode invocation with stream-json and unattended flags', () => {
    expect(buildAntigravityArgs({ prompt: 'hello' })).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
    ]);
  });

  it('resumes with --conversation and never uses --continue', () => {
    const args = buildAntigravityArgs({
      prompt: 'continue',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      model: 'claude-sonnet-4-6',
    });
    expect(args).toEqual([
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--conversation',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '--model',
      'claude-sonnet-4-6',
    ]);
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--continue');
  });

  it('keeps the prompt as a single argv element even with XML-ish content', () => {
    const prompt = '<bridge_context>{"chatId":"oc_1"}</bridge_context>\n\nhello > world';
    const args = buildAntigravityArgs({ prompt });
    expect(args[1]).toBe(prompt);
  });
});
