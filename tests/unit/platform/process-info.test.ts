import { describe, expect, it } from 'vitest';
import { processMatchesIdentity } from '../../../src/platform/process-info';

describe('processMatchesIdentity', () => {
  it('refuses to match when a recorded start time cannot be verified', () => {
    expect(
      processMatchesIdentity(4242, 1_760_000_000_000, {
        isAlive: () => true,
        processStartMs: () => undefined,
      }),
    ).toBe(false);
  });

  it('matches a live pid whose start time is within skew', () => {
    expect(
      processMatchesIdentity(4242, 1_760_000_000_000, {
        isAlive: () => true,
        processStartMs: () => 1_760_000_000_250,
      }),
    ).toBe(true);
  });

  it('matches a live pid when no start time was recorded', () => {
    expect(
      processMatchesIdentity(4242, undefined, {
        isAlive: () => true,
        processStartMs: () => undefined,
      }),
    ).toBe(true);
  });
});
