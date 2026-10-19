/** CardKit `sequence` is a positive int32. Seconds since this epoch stay inside it for decades. */
export const CARD_SEQUENCE_EPOCH_MS = Date.UTC(2026, 0, 1);
export const CARD_SEQUENCE_MAX = 2_147_483_647;

/**
 * Next CardKit sequence: `max(stored + 1, seconds since the epoch, last attempt + 1)`.
 * `attempted` is the highest sequence already sent in this process. It is not stored.
 * A missed success still moves forward once wall time passes the server's value.
 */
export function monotonicCardSequence(
  stored: number | undefined,
  nowMs: number,
  attempted = 0,
): number {
  const fromStored = positive(stored) + 1;
  const fromTime = cardSequenceFromTime(nowMs);
  const fromAttempt = positive(attempted) > 0 ? positive(attempted) + 1 : 1;
  return clampSequence(Math.max(fromStored, fromTime, fromAttempt));
}

function cardSequenceFromTime(nowMs: number): number {
  if (!Number.isFinite(nowMs)) return 1;
  return clampSequence(Math.floor((nowMs - CARD_SEQUENCE_EPOCH_MS) / 1000));
}

function positive(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function clampSequence(value: number): number {
  if (value < 1) return 1;
  if (value > CARD_SEQUENCE_MAX) return CARD_SEQUENCE_MAX;
  return value;
}
