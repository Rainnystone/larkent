# T16: Exactly-once delivery: Feishu uuid, same-card recovery, read-back

**Status:** ready-for-agent (mandatory) · Order: after T11, before T12 and T13 · Audit: D8 (F11), plus the user's I1 decision (2026-10-17) · Facts verified by a live Feishu proof run on 2026-10-17 (spec §4a)

## Goal

Make retries and redelivery idempotent so every inbound message gets exactly one complete answer: no duplicate, no loss (spec I1, I2a, §4a).

- **uuid on every final send.**
  - Pass the stable per-turn `deliveryId` (`replyDeliveryKey(turnId)`, persisted in the turn journal, ≤ 50 chars) as `uuid` on `im.v1.message.create` / `reply`.
  - Do it inside the SDK's `rawSend` via a `pnpm patch` of `@larksuite/channel`, so the SDK's internal `rawSendWithRetry` retries are deduped too. Feishu sends at most one message per uuid within 1 h.
  - Stop stripping it (`stripOutboundUuid`). Notices use their own stable key.
  - A duplicate uuid returns code 0 and the **original** `message_id`, never an error. Record only the returned `message_id` as the receipt; **never trust the response body** (it echoes the new content, while the stored message keeps the original).
- **Same-card recovery primitive** (used by T12):
  - Given the recorded stream/card message id, do a replace-all patch of the interactive card (`updateCard` / `im.v1.message.patch`) with the full answer. Never send a new message for a turn that has a card.
  - CardKit `updateCardById` is not used for recovery: its content was not verifiable by read-back.
- **Read-back beyond the uuid window:**
  - Before a redelivery send outside the 1 h window, list the chat with `rawClient.im.v1.message.list`. It does not expose uuid.
  - Match on `parent_id` == the triggering inbound message id, sender == the bot's app id (the list shows app id, not open_id), and `create_time` after turn start, or on the recorded receipt id.
  - Page with a hard cap. Allow for about 2 s of list visibility lag.
  - Do **not** add visible markers to reply content.
  - Send only on no match; patch instead if a matching card exists.

## Spec sections

Delivery invariants (I1, I2a); §4a Exactly-once delivery; Known limitations

## Acceptance (behaviour, failing first; the SDK-faithful fake dedupes uuid exactly as Feishu does)

- [ ] A send lands but its response is lost; recovery resends with the same uuid → the original `message_id` comes back, the chat holds one message, and the item is recorded as sent with that id.
- [ ] The SDK retries internally after an `unknown` error, and the first attempt had landed → exactly one message in the chat.
- [ ] A repeat send with the same uuid but changed content → the receipt is the original `message_id`; the bridge does not treat the echoed body as what is displayed.
- [ ] A notice sent twice with the same key → one notice.
- [ ] Streamed final patch fails → the same card, patched replace-all, ends with the full answer; patching it twice leaves one card and no new message.
- [ ] Outage longer than 1 h, earlier reply landed unconfirmed → the read-back finds it by `parent_id` + bot app id + `create_time` and nothing is sent; with no match, exactly one send.
- [ ] Read-back pages stop at the cap, and reply content contains no matching markers.
- [ ] `deliveryId` persists across a restart, is ≤ 50 chars, and is the same value on every attempt.
- [ ] `pnpm ci:local` passes.

## Files likely touched

`patches/@larksuite__channel*.patch` + `package.json` `pnpm.patchedDependencies`, `src/bot/self-message.ts` (stop stripping uuid), `src/bot/turn-journal.ts` (keeps `deliveryId`), `src/bot/channel.ts` (redelivery path, card patch, read-back), SDK-faithful fake (dedupes uuid and returns the original id plus the echoed body; list without uuid, sender as app id), spec

## Delete

`stripOutboundUuid` (if still present). `deliveryId` is **kept**.

## Blocked by

T11
