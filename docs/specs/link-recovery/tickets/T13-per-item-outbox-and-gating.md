# T13: Per-item reply/notice state; no sends while down

**Status:** ready-for-agent · Audit: D4 + D5 (F9, F10, F12, F13, F14, F17; J1–J3)

## Goal

- Reply and notice are separate journal items (I8). `reply.state` and `notice.state` are each `staged | sent(receipt) | rejected | voided`, separate from the run `status`.
- One `attempt(item)`: classify the outcome (T11), record the receipt, and on `rejected` run the per-kind fallback (plain text for replies), then make the item terminal.
- `resendJournalReply` returns its receipt; it is no longer thrown away (J2).
- Abandoning or voiding touches only the notice and continuation, never a staged reply (J1). Exception: supersede and `/new` still void the staged answer (F26, kept as intended; see Known limitations).
- Gate on `link.isDown()` in `deliverFinalReply`, `sendTurnNotice` and `redeliver`: stage and return (I6).
- Redeliver stops at the first `link` error; the rest go out at the next recovery.
- Keep T10 item 2 (skip redelivery when the agent already sent via CLI) on the new model.

## Spec sections

Delivery invariants (I3, I6, I8); §4 Outbox

## Acceptance (behaviour, failing first)

- [ ] Every redelivery attempt reuses the item's `deliveryId` and runs the T16 read-back first: a reply whose earlier send landed but was not confirmed is marked sent, with no second message.
- [ ] J2: reply redelivered, notice fails, second recovery → the chat holds exactly one answer.
- [ ] J1: abandoned offer with a staged reply → the reply is delivered once; the entry is terminal and prunable.
- [ ] J3: an entry that is settled with a reply is sent once per pass, not twice.
- [ ] The link drops in the middle of the redelivery loop → the loop stops; the rest go out at the next recovery, each exactly once.
- [ ] Link down at turn end → zero send calls until recovery, then exactly one.
- [ ] Completed-but-undelivered rows are retried by a bounded sweep that runs whether the link is up or down. Each retry is always a same-card patch, never a send without a uuid. If the card is permanently gone (a 4xx that can never succeed), the row falls back to a reply keyed by the row's stored uuid, so the user gets exactly one complete answer (I1).
- [ ] A final patch fails once with a 4xx while the link stays up → the user still receives exactly one complete reply.
- [ ] The card is permanently gone → exactly one reply keyed by the row's stored uuid.
- [ ] An old journal file (shared `status`) loads and its staged items are delivered once.
- [ ] `pnpm ci:local` passes.

## Files likely touched

`src/bot/turn-journal.ts`, `src/bot/channel.ts` (`deliverFinalReply`, `resendJournalReply`), `src/bot/interruption-notice.ts`, journal/notice tests

## Delete

- The `settled`+reply branch in `redeliver` (~`turn-journal.ts:425-444`) and the `settled` case in `isStagedDelivery`
- `replyAlreadyVisible`'s three-way OR (replaced by the single receipt)
- `recover()` / `recoverOwned` / `recovering` (no callers in `src`)
- The `mark*` aliases
- (`deliveryId` is **kept**; it is the Feishu uuid and the read-back key from T16.)

## Blocked by

T12
