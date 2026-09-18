import { describe, expect, it } from 'vitest';
import { scrubSystemMessageEnvelopes } from '../../../src/agent/antigravity/envelopes';
import {
  ENVELOPE_CLASSIFIER_MATRIX,
  INCIDENT_A_MESSAGE_ID,
  TASK_NOTIFICATION_CHINESE_ANSWER,
  TASK_NOTIFICATION_MATRIX,
  VITEST_TITLE_WITH_SYSTEM_MESSAGE,
  matrixRow,
  taskNotificationRow,
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

  it.each([
    ['leftover mid-line closer', matrixRow('B5').input],
    ['inline code closer', 'Use `</SYSTEM_MESSAGE>` when writing the prompt.'],
    ['fenced closer', ['```', '</SYSTEM_MESSAGE>', '```', 'kept after fence'].join('\n')],
  ])('does not peel a B4 opener through a later %s', (_label, citedCloser) => {
    const input = [matrixRow('B4').input, citedCloser].join('\n');
    const result = scrubSystemMessageEnvelopes(input);
    expect(result.text).toBe(input);
    expect(result.removedCount).toBe(0);
    expect(result.unclosed).toBe(false);
    expect(result.retainedReasons).toEqual(['unclosed-no-fingerprint']);
  });
});

describe('task_notification envelope family #2', () => {
  it.each(TASK_NOTIFICATION_MATRIX)(
    '$id returns the locked family #2 text and telemetry',
    (row) => {
      const result = scrubSystemMessageEnvelopes(row.input);
      expect(result.text).toBe(row.expectedText);
      expect(result.beforeLength).toBe(row.input.length);
      expect(result.afterLength).toBe(row.expectedText.length);
      expect(result.removedCount).toBe(row.removedCount);
      expect(result.unclosed).toBe(row.unclosed);
      expect(result.preambleRemoved).toBe(row.preambleRemoved);
      expect(result.retainedReasons).toEqual(row.retainedReasons);
      expect(result.taskNotificationRetainedReasons).toEqual(row.taskNotificationRetainedReasons);
      if (row.removedCount > 0) {
        expect(result.text).not.toContain('<task_notification');
      }
    },
  );

  it('does not peel an unfingerprinted task_notification opener through a later cited closer', () => {
    const input = `${taskNotificationRow('TN6').input}\noops </task_notification> leftover closer`;
    const result = scrubSystemMessageEnvelopes(input);
    expect(result.text).toBe(input);
    expect(result.removedCount).toBe(0);
    expect(result.taskNotificationRetainedReasons).toEqual(['unclosed-no-fingerprint']);
  });

  it('TN1 drops the task_notification envelope and keeps the vitest title plus Chinese answer', () => {
    const row = taskNotificationRow('TN1');
    const result = scrubSystemMessageEnvelopes(row.input);
    expect(result.text).toBe(row.expectedText);
    expect(result.text).toContain(TASK_NOTIFICATION_CHINESE_ANSWER);
    expect(result.text).toContain(VITEST_TITLE_WITH_SYSTEM_MESSAGE);
    expect(result.text).not.toContain('<task_notification');
    const titleIndex = result.text.indexOf(VITEST_TITLE_WITH_SYSTEM_MESSAGE);
    expect(result.text.slice(titleIndex, titleIndex + VITEST_TITLE_WITH_SYSTEM_MESSAGE.length)).toBe(
      VITEST_TITLE_WITH_SYSTEM_MESSAGE,
    );
  });
});
