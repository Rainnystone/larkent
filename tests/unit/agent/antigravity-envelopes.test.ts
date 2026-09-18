import { describe, expect, it } from 'vitest';
import { scrubSystemMessageEnvelopes } from '../../../src/agent/antigravity/envelopes';
import {
  ENVELOPE_CLASSIFIER_MATRIX,
  INCIDENT_A_MESSAGE_ID,
  matrixRow,
} from '../../fixtures/antigravity/envelope-classifier-matrix';

describe('scrubSystemMessageEnvelopes', () => {
  it.each(ENVELOPE_CLASSIFIER_MATRIX)(
    '$id returns the locked classifier text and telemetry',
    (row) => {
      const result = scrubSystemMessageEnvelopes(row.input);
      expect(result.text).toBe(row.expectedText);
      expect(result.beforeLength).toBe(row.input.length);
      expect(result.afterLength).toBe(row.expectedText.length);
      expect(result.removedCount).toBe(row.removedCount);
      expect(result.unclosed).toBe(row.unclosed);
      expect(result.preambleRemoved).toBe(row.preambleRemoved);
      expect(result.retainedReasons).toEqual(row.retainedReasons);
      expect(JSON.stringify(result)).not.toContain('truncated envelope body that must not leak');
    },
  );

  it('A2 cites the Incident A outbound message id while using the redacted payload shape', () => {
    expect(INCIDENT_A_MESSAGE_ID).toBe('om_x100b65e6a11b3cb4b10254b74b00974');
    const row = matrixRow('A2');
    expect(scrubSystemMessageEnvelopes(row.input).text).toBe(row.expectedText);
  });

  it('B4 keeps the whole string byte-identical when an unclosed opener has no fingerprint', () => {
    const row = matrixRow('B4');
    expect(scrubSystemMessageEnvelopes(row.input).text).toBe(row.input);
  });
});
