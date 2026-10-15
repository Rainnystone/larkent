# Delivery note: 1: 丢消息修复（全部路径）

**Status:** delivered (deterministic layer)

- Code PR: [#39](https://github.com/Rainnystone/larkent/pull/39)
- SHA: `fde51ee28edce424eff6d421656887e424b86d35` (`feat/run-reliability`)
- Evidence:
  - TDD red: missing `BackfillLedger.unrecord`; `cancelAll` returned void; `commandClearsPending` missing; short-gap still skipped with `incompleteFrom`; truncated ids recorded; mention-free groups dropped; reconnect copy still promised a later retry that did not happen.
  - TDD green: ledger unrecord + v1 extra-field load; pending `cancelAll` returns messages; command classifier; backfill `forced` / truncation recoverable / mention-free enqueue; channel scenarios in `tests/integration/bot/lost-message.test.ts` (`/reconnect`, restart + closing arrival, SIGTERM reload, 25s short-gap, `/status` keeps + `/stop` confirms); supervisor `recoverMissed` after old disconnect.
  - `pnpm ci:local`: green on `fde51ee` (typecheck + full vitest + build).
  - test bridge: first five scenes covered by the recording-channel vitest layer. Live `e2e:up` / send / read / 25s disconnect was **not** run here (no isolated tester credentials; live data root not touched). No ids or tokens recorded.
- Residual risk:
  - Live `redelivery-short-gap` is still pending credentials. `reliability.shortGapScan` defaults off (master skip); discarded pending already forces a scan via `incompleteFrom`.
  - `/stop` confirms the drop and **keeps** the ledger id (Spec §5.3 confirm-or-unrecord) so a later backfill does not revive a user-cancelled queue. The ticket test-plan wording “且 ledger 已撤销” is not followed on purpose.
  - `/resume` without `use` is treated as read-only (does not clear pending); only `/resume use` clears.
  - Closing-period `cardAction` / `comment` still return without handoff (IM `message` is marked incomplete).
  - Flag off: `profile.reliability.lostMessage: false` matches master.
