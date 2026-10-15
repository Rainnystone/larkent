# Delivery note: 3: interruption notice 卡片

**Status:** delivered (deterministic layer)

- Code PR: [#39](https://github.com/Rainnystone/larkent/pull/39)
- SHA: `087ef80e12c7922fe9893e71b008de3bafd5f294` (`feat/run-reliability`)
- Evidence:
  - TDD red: `reliability.notice` missing (defaulted on/undefined); no `NoticeActionAuth` / `notice.continue` card; continue replayed the live session instead of the journal handle; no-handle continue resumed a stale store session; fourth consecutive notice still had buttons; `/new` left the streak intact; send-fail never reached `notice-pending`.
  - TDD green: `profile.reliability.notice === true` opt-in (default off). Qualifying `interrupted` / retriable `failed`/`partial` posts an @-initiator 继续/暂不 card (`notice.continue` / `notice.dismiss`) with “或 @bot 继续” when the chat requires a mention; topic groups `replyInThread`. Signed action binds turnId + journal policy fingerprint + one-time nonce + TTL; voided/`noticeInvalidated` / fingerprint mismatch / fence fail / replay / expiry all reject. Continue uses `forceResumeHandle` (journal handle, or `null` to rerun stored `userInput`) plus a one-time `continueHint`; the next ordinary message in that scope also gets the hint once. Streak of 3 keeps buttons, 4th is plain, ordinary message and `/new`/`/cd` reset. Auth-required: initiator in-chat once + owner DM once, no continue, new runs still accepted. Failed sends stay `notice-pending` and recover rate-limits (500ms). Tests: `tests/unit/bot/interruption-notice.test.ts`, `tests/unit/card/notice-dispatch.test.ts`, `tests/integration/bot/interruption-notice.test.ts`, plus journal recover / profile-schema / `forceResumeHandle` cases. Scenario wired: `pnpm e2e:scenario -- cursor-stall-notice`.
  - `pnpm ci:local`: green on `087ef80` (typecheck + full vitest + build). No separate lint script in this repo.
  - GitHub CI: green on `087ef80` — Node 20 ubuntu-latest, macos-latest, and windows-latest.
  - test bridge: live `cursor-stall-notice` was **not** run (no isolated tester credentials; live data root not touched). Deterministic channel tests cover card continue, `@bot 继续`, fence, `/new` `/cd` invalidation, no-handle rerun, 4th-plain + reset, topic thread, send-fail recover-once, auth D10, and flag off. The scenario cannot click a live card. No ids or tokens recorded.
- Residual risk:
  - Flag off: `profile.reliability.notice` unset/false matches ticket 4 (no notice card).
  - No-handle “原批次” replays joined text `userInput` only, not attachments.
  - Auth-required dedup is journal-global for the process lifetime of that file (repeat auth in another chat will not re-notify).
  - Crash between a successful interrupt reply and `markNoticePending` can still miss the notice (status is `settled`, not `completed-undelivered`).
  - Live test-bridge button click still pending credentials (same residual as 0b/1/4/5).
