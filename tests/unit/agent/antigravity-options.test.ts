import { describe, expect, it } from 'vitest';
import { parseClaudeAgentOptions } from '../../../src/agent/claude/options';
import { parseCodexAgentOptions } from '../../../src/agent/codex/options';
import { parseCursorAgentOptions } from '../../../src/agent/cursor/options';
import { parseGrokAgentOptions } from '../../../src/agent/grok/options';
import { parseKimiAgentOptions } from '../../../src/agent/kimi/options';
import {
  antigravityAgentOptionsSchema,
  antigravityPolicyInputs,
  parseAntigravityAgentOptions,
} from '../../../src/agent/antigravity/options';

describe('parseAntigravityAgentOptions', () => {
  it.each(['30s', '5m', '10m', '1h', '1h30m'] as const)(
    'accepts printTimeout duration %s',
    (printTimeout) => {
      expect(parseAntigravityAgentOptions({ printTimeout }, true)).toEqual({ printTimeout });
      expect(antigravityAgentOptionsSchema.parse({ printTimeout })).toEqual({ printTimeout });
    },
  );

  it('keeps sandbox when printTimeout is also set', () => {
    expect(
      parseAntigravityAgentOptions(
        { sandbox: 'danger-full-access', printTimeout: '15m' },
        true,
      ),
    ).toEqual({ sandbox: 'danger-full-access', printTimeout: '15m' });
  });

  it('omits printTimeout when the field is unset', () => {
    expect(parseAntigravityAgentOptions({}, true)).toEqual({});
    expect(parseAntigravityAgentOptions({ sandbox: 'danger-full-access' }, true)).toEqual({
      sandbox: 'danger-full-access',
    });
  });

  it.each([
    '',
    '10',
    '10minutes',
    '5M',
    '-5m',
    '0s',
    ' 5m',
    '5m ',
    10,
    true,
    null,
  ])('rejects invalid printTimeout %j', (printTimeout) => {
    expect(() => parseAntigravityAgentOptions({ printTimeout }, true)).toThrow(
      /invalid antigravity agent option printTimeout/,
    );
    expect(() => parseAntigravityAgentOptions({ printTimeout }, false)).toThrow(
      /invalid antigravity agent option printTimeout/,
    );
  });

  it('rejects unknown keys on the existing strict path', () => {
    expect(() => parseAntigravityAgentOptions({ nope: true }, true)).toThrow(
      'unknown antigravity agent option: nope',
    );
    expect(() =>
      parseAntigravityAgentOptions({ printTimeout: '5m', extra: 1 }, true),
    ).toThrow('unknown antigravity agent option: extra');
  });

  it('does not treat printTimeout as a policy fingerprint input', () => {
    expect(antigravityPolicyInputs({ printTimeout: '10m' })).toEqual({});
    expect(antigravityPolicyInputs({})).toEqual({});
  });
});

describe('printTimeout is antigravity-only', () => {
  it.each([
    ['claude', parseClaudeAgentOptions, 'unknown claude agent option: printTimeout'],
    ['codex', parseCodexAgentOptions, 'unknown codex agent option: printTimeout'],
    ['cursor', parseCursorAgentOptions, 'unknown cursor agent option: printTimeout'],
    ['grok', parseGrokAgentOptions, 'unknown grok agent option: printTimeout'],
    ['kimi', parseKimiAgentOptions, 'unknown kimi agent option: printTimeout'],
  ] as const)('strict %s parse rejects printTimeout', (_kind, parse, message) => {
    expect(() => parse({ printTimeout: '10m' }, true)).toThrow(message);
  });
});
