export const REQUIRED_OBSERVABILITY_EVENTS = [
  'run.started',
  'run.completed',
  'run.failed',
  'policy.denied',
  'callback.denied',
  'access.owner_refresh_failed',
  'jsonl.unknown_event',
  'attachment.decision',
  'comment.reply_failed',
] as const;

export type RequiredObservabilityEvent = (typeof REQUIRED_OBSERVABILITY_EVENTS)[number];

export const REQUIRED_BACKFILL_EVENTS = [
  'backfill.trigger',
  'backfill.skip-short-gap',
  'backfill.skip-disabled',
  'backfill.skip-no-identity',
  'backfill.watermark-initialized',
  'backfill.chats',
  'backfill.chats-truncated',
  'backfill.chat-scanned',
  'backfill.enqueued',
  'backfill.would-enqueue',
  'backfill.done',
  'backfill.coalesced',
  'backfill.aborted',
  'backfill.chats-fetch-failed',
  'backfill.chat-fetch-failed',
  'backfill.normalize-failed',
  'backfill.clock-skew',
  'backfill.skip-deleted',
  'backfill.skip-self',
  'backfill.skip-processed',
  'backfill.skip-command',
  'backfill.raw-truncated',
  'backfill.mentions-truncated',
  'backfill.topic-partial',
] as const;

export type RequiredBackfillEvent = (typeof REQUIRED_BACKFILL_EVENTS)[number];
