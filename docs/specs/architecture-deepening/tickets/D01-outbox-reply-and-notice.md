# D01 Outbox owns reply and notice delivery

Spec: D4, D5, §5 Testing, A2, A3. Blocked by: none.
Touch: `src/bot/channel.ts` (delivery functions and sweep), `src/bot/turn-journal.ts`, `src/bot/feishu-delivery.ts`, `src/bot/interruption-notice.ts` (send side only), `src/bot/recovery.ts` wiring, new `src/bot/outbox.ts` (or `src/bot/outbox/`), tests, `CONTEXT.md`.

## Why

Reply and notice delivery is a dozen private functions in `channel.ts` (`deliverFinalReply` 2548, `settleStreamDelivery` 2728, `sendOrWait` 2785, `recordSend` 2834, `resendJournalReply` 2847, `stagedOutboxCount` 2949, `sendFinalReply` 2958, `sendPlainTextReply` 3020, `recallReplacedMessage` 2703, `stageTurnNotice` / `sendTurnNotice` 3490-3530) plus the sweep timer (801-857). The only seam is `startChannel`. Recall and flush-order fixes (`4d78a0be`, `d0063a5e`, `a27e564c`, `521c34e8`) each touched `channel.ts` and `turn-journal.ts` together.

## Do

1. Characterize: confirm these stay green on the branch before and after the move, and add a test for any reply-mode / stream-kind combination they do not pin: `tests/integration/bot/stream-delivery.test.ts`, `final-reply-dedup.test.ts`, `feishu-uuid-idempotency.test.ts`, `outbox-gating.test.ts`, `progress-card-patch-failure.test.ts`, `skip-cli-already-sent.test.ts`, `interruption-notice.test.ts`, `turn-journal.test.ts`, `lost-message.test.ts`, `tests/integration/runtime/turn-journal-restart.test.ts`.
2. Red: write Outbox interface tests with a real turn journal on a temp file and `tests/helpers/recording-lark-channel.ts`: link down stages and returns; rejected falls back once to plain text; local retries once then waits; not-in-chat rejects and surfaces; confirmed stream marks delivered before the deferred flush; failed stream with a receipt patches in place; supersede recall retry / done / permanent; redelivery outside the uuid window reads back. Add crash-ordering tests (kill between stage and send, between send and receipt, during recall; recover; exactly one visible message).
3. Green: move the delivery functions and the sweep into the Outbox module behind the interface in the tickets README. `channel.ts` calls only the Outbox for final replies, notices, redelivery and sweep. `TurnJournal` keeps turn lifecycle and persistence; Outbox owns item state transitions.
4. Bump the turn journal to schema v2 with Outbox items keyed by `deliveryId` (D5). Atomic v1 upgrade preserves staged reply / notice items; add a v1 fixture test that restarts and redelivers exactly once.
5. Delete `startChannel`-level assertions that only pinned moved internals. Update `CONTEXT.md` › outbox and › turn journal to name the Outbox module as the owner and describe journal v2.
6. `/code-review` against the Spec.

## Acceptance

- [ ] No `classify`, `withDeliveryUuid`, `redeliverStagedReply`, recall or sweep logic for replies / notices remains in `channel.ts` or `interruption-notice.ts`.
- [ ] Outbox interface tests and crash-ordering tests pass without `startChannel`.
- [ ] Journal v1 with staged items upgrades atomically and redelivers once; a future version is refused without replacing the file.
- [ ] All tests listed in Do 1 stay green; the seven-CLI bridge contract tests (`tests/process/seven-cli-bridge-contract.*.test.ts`) stay green.
- [ ] `pnpm ci:local` green; delivery note posted.
