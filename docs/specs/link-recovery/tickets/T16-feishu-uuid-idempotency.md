# T16 (optional): Feishu-side idempotency for final replies and notices

**Status:** optional · do last, only if cheap · Audit: D8 (F11)

## Goal

Send final replies and notices with `uuid = deliveryId` (Feishu dedupes the same `uuid` for 1 hour), so a send that timed out but landed is not duplicated by redelivery. This needs a raw-client sender or an SDK option. If neither is cheap, close the ticket and leave F11 as a known limitation.

## Spec sections

Known limitations (Redelivered final reply); §4 Outbox

## Acceptance (behaviour, failing first)

- [ ] A timed-out send that actually lands, followed by redelivery within 1 hour → exactly one message in the chat.
- [ ] Same for a notice.
- [ ] Spec Known limitations updated (F11 removed or narrowed to > 1 h).
- [ ] `pnpm ci:local` passes.

## Files likely touched

`src/bot/turn-journal.ts` (keeps `deliveryId`), `src/bot/channel.ts` / `src/bot/self-message.ts` (sender), spec

## Delete

Nothing. If T16 is dropped, T13 deletes `deliveryId`.

## Blocked by

T15
