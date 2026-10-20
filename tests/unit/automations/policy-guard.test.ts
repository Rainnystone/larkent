import { describe, expect, it } from 'vitest';
import { inspectAutomationToolUse } from '../../../src/automations/policy-guard';

describe('automatic tool authentication/configuration policy', () => {
  it.each([
    ['auth', 'logout', '--help'],
    ['auth', 'login', '-h'],
    ['profile', 'add', '--help'],
    ['config', 'set', '--help'],
    ['help', 'auth', 'logout'],
    ['help', 'config', 'set'],
    ['--help', 'auth', 'logout'],
    ['--profile', 'synthetic', 'auth', 'login', '-h'],
    ['auth', 'status'],
    ['config', 'show'],
    ['config', 'strict-mode'],
    ['config', 'default-as'],
    ['docs', '+fetch', '--as', 'user'],
  ])('allows read-only help and existing identity use: %j', (...args) => {
    expect(inspectAutomationToolUse({ name: 'Bash', input: { command: ['lark-cli', ...args] } })).toBeUndefined();
  });

  it.each([
    ['auth', 'logout'],
    ['auth', 'login'],
    ['config', 'set', 'k', 'v'],
    ['profile', 'add', 'synthetic'],
    ['config', 'strict-mode', 'off'],
    ['config', 'default-as', 'user'],
    ['config', 'strict-mode', '--reset'],
    ['auth', 'logout', '--', '--help'],
    ['auth', 'login', '--', '-h'],
    ['config', 'set', 'k', '--', '--help'],
    ['auth', 'logout', '--help=false'],
    ['auth', 'logout', '--helper'],
    ['--profile', '--help', 'auth', 'logout'],
    ['--as', '-h', 'config', 'set', 'k', 'v'],
  ])('still blocks mutations, including help-looking data: %j', (...args) => {
    expect(inspectAutomationToolUse({ name: 'Bash', input: { command: ['lark-cli', ...args] } }))
      .toEqual({ reason: 'auth-config' });
  });

  it.each([
    'lark-cli auth logout --help && lark-cli auth logout',
    'lark-cli config set k v; lark-cli config set --help',
    'lark-cli help auth logout || lark-cli config set k v',
    'lark-cli auth login -h | lark-cli auth logout',
    'lark-cli auth logout --help\nlark-cli config set k v',
    'bash -c "lark-cli auth logout --help && lark-cli auth logout"',
    'lark-cli auth logout --help $(lark-cli auth logout)',
    'lark-cli auth logout --help `lark-cli auth logout`',
  ])('checks every command even when another command requests help: %s', command => {
    expect(inspectAutomationToolUse({ name: 'Bash', input: { command } })).toEqual({ reason: 'auth-config' });
  });

  it('allows quoted help inside a shell wrapper', () => {
    expect(inspectAutomationToolUse({ name: 'Bash', input: { command: 'bash -c "lark-cli auth logout --help"' } }))
      .toBeUndefined();
  });
});
