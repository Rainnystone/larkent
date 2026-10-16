import { describe, expect, it } from 'vitest';
import { stripArgvSeparators } from '../../../e2e/test-bridge/argv';

describe('e2e argv separators', () => {
  it('drops the pnpm-forwarded -- so `pnpm e2e:fault -- arm` matches the CLI', () => {
    expect(stripArgvSeparators(['fault', '--', 'arm', 'cursor-stall'])).toEqual([
      'fault',
      'arm',
      'cursor-stall',
    ]);
    expect(stripArgvSeparators(['up', '--', '--real-cli'])).toEqual(['up', '--real-cli']);
    expect(stripArgvSeparators(['--', 'scenario', '--', 'redelivery-short-gap'])).toEqual([
      'scenario',
      'redelivery-short-gap',
    ]);
  });
});
