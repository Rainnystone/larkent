# T16: Exactly-once delivery: Feishu uuid, same-card recovery, read-back

**Status:** ready-for-agent (mandatory) · Order: after T11, before T12 and T13 · Audit: D8 (F11), plus the user's I1 decision (2026-10-17)

## Goal

Make retries and redelivery idempotent so every inbound message gets exactly one complete answer: no duplicate, no loss (spec I1, I2a, §4a).
- **uuid on every final send.**
  - Pass the stable per-turn `deliveryId` (`replyDeliveryKey(turnId)`, already persisted in the turn journal) as `uuid` on `im.v1.message.create` / `reply`.
  - Do it inside the SDK's `rawSend` via a `pnpm patch` of `@larksuite/channel`, so the SDK's internal `rawSendWithRetry` retries (on `unknown` errors) are deduped too. Feishu dedupes the same uuid for about 1 h.
  - Stop stripping it (`stripOutboundUuid`). Notices use their own stable key.
- **Same-card recovery primitive** (used by T12): given a recorded stream/card message id, do a replace-all patch with the full answer (`updateCard`, or CardKit `updateCardById`, which already carries a uuid). Never send a new message for a turn that has a card.
- **Read-back beyond the uuid window:**
  - Before any redelivery send, list the bot's own messages in the chat after the turn started (`rawClient.im.v1.message.list`).
  - Match on the recorded receipt id or `deliveryId`. Send only if there is no match; patch instead if a matching card exists.
  - Record the exact matching rule (fields available in the list response) in the PR.

## Spec sections

Delivery invariants (I1, I2a); §4a Exactly-once delivery; Known limitations

## Acceptance (behaviour, failing first, against the SDK-faithful fake from T11)

- [ ] A send times out but actually lands → recovery produces no second message (uuid dedupe); the item is recorded as sent.
- [ ] The SDK retries internally after an `unknown` error, and the first attempt had landed → exactly one message in the chat.
- [ ] A notice sent twice with the same key → one notice.
- [ ] Outage longer than 1 h, earlier send landed unconfirmed → the read-back finds it and the chat holds one message; with no match, exactly one send.
- [ ] Same-card patch primitive: patching the recorded card twice leaves one card with the full answer and no new message.
- [ ] `deliveryId` persists across a restart and is the same value on every attempt.
- [ ] `pnpm ci:local` passes.

## Files likely touched

`patches/@larksuite__channel*.patch` + `package.json` `pnpm.patchedDependencies`, `src/bot/self-message.ts` (stop stripping uuid), `src/bot/turn-journal.ts` (keeps `deliveryId`), `src/bot/channel.ts` (redelivery path, read-back), SDK-faithful fake (records uuid; dedupes like Feishu), spec

## Delete

`stripOutboundUuid` (if still present). `deliveryId` is **kept**.

## Blocked by

T11
