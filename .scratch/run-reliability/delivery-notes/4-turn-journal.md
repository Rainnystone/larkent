# Delivery note: 4: turn journal（未送达重发、孤儿检测、session 切换作废）

**Status:** delivered (deterministic layer)

- Code PR: [#39](https://github.com/Rainnystone/larkent/pull/39)
- SHA: `13ad3dd10ffd673b244cb562179125bb36bf7990` (`feat/run-reliability`)
- Evidence:
  - TDD red: `TurnJournal` module missing; `turn-journal.json` path/flags missing; JSONL runner still in the bridge process group; recording-channel send-fail never reached `completed-undelivered`; `/new` `/cd` `/ws use` `/resume` left the dying run as `reply-delivered` over `voided`.
  - TDD green: supervisor-owned `turn-journal.json` schema v1 (atomic 0o600, bounded prune, corrupt/future-schema freeze). Failed finals persist as `completed-undelivered` before send and resend once on `recoverMissed`. Detached JSONL CLIs are reaped by pid + start time; `supersedeSession` / `/new` void incomplete records (later settle/reply cannot un-void). `reliability.journal` default on; `journalRecover` ANDs with writes. Tests: `tests/unit/bot/turn-journal.test.ts`, `tests/unit/bot/turn-journal-rollback.test.ts`, `tests/integration/bot/turn-journal.test.ts`, `tests/integration/runtime/turn-journal-restart.test.ts`, `tests/process/turn-journal-orphan.test.ts`. Scenario wired: `pnpm e2e:scenario -- journal-kill-group`.
  - `pnpm ci:local`: green on `13ad3dd` (typecheck + full vitest + build). No separate lint script in this repo.
  - GitHub CI follow-up: Node 20 on windows-latest failed on `706028b` (`session-command-race` `/stop` hit the default 5s). `13ad3dd` raises that case to 20s (same budget as the sibling race test) and gives `expectNextRun` waitFor 5s. Ubuntu/macOS were already green.
  - test bridge: live `journal-kill-group` was **not** run (no isolated tester credentials; live data root not touched). POSIX process tests cover kill-9 parent + orphan reap with exactly-once `journal.recovered`. No ids or tokens recorded.
- Residual risk:
  - Flag off: `profile.reliability.journal: false` matches master (no journal file). `journalRecover: false` keeps writes but skips resend/orphan actions.
  - Session switch still posts the existing interrupt terminal text; notice cards are ticket 3.
  - Resend always uses stored markdown, including turns that originally replied as a card.
  - Live test-bridge `journal-kill-group` still pending credentials (same residual as 0b/1/5).
