import { describe, expect, it } from 'vitest';
import { CARD_SEQUENCE_EPOCH_MS, CARD_SEQUENCE_MAX, monotonicCardSequence } from '../../../src/automations/card-sequence';

describe('monotonicCardSequence', () => {
  it('uses the time floor when stored is behind, and stored+1 when stored is ahead', () => {
    const now = CARD_SEQUENCE_EPOCH_MS + 2_500_000 * 1000;
    expect(monotonicCardSequence(5, now)).toBe(2_500_000);
    expect(monotonicCardSequence(3_000_000, now)).toBe(3_000_001);
  });

  it('steps past a sequence already sent in this process', () => {
    const now = CARD_SEQUENCE_EPOCH_MS + 2_500_000 * 1000;
    expect(monotonicCardSequence(undefined, now, 2_500_000)).toBe(2_500_001);
  });

  it('stays inside the positive int32 range', () => {
    expect(monotonicCardSequence(undefined, CARD_SEQUENCE_EPOCH_MS - 5_000)).toBe(1);
    expect(monotonicCardSequence(CARD_SEQUENCE_MAX, CARD_SEQUENCE_EPOCH_MS)).toBe(CARD_SEQUENCE_MAX);
  });
});