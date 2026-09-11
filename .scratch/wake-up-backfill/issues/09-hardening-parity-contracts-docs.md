# 09: Hardening — cross-agent parity, static contracts, operator docs

**What to build:** Proof that self-heal is a peer-equal, portable capability, and the operator-facing documentation to run it. A parity test parameterized over every registered agent kind shows that a backfilled @mention produces the same channel call sequence as the identical live message plus exactly one lateness hint line. Static contracts pin the required `backfill.*` / `intake.skip-duplicate` events and assert that the self-heal code paths and defaults contain no profile, bot or agent-kind names. `docs/operations.md` gains a "Self-heal" section: what happens after sleep/restart/blip, the log lines to watch (`keepalive.wake-up` or `ws.reconnected` → `backfill.trigger` → `backfill.done`), the `/doctor` line, the kill switch and dry-run, and a **generic** staged-rollout note ("enable on one profile, watch one recovery cycle, then the others") with no named bots.

**Blocked by:** 07, 08

**Status:** ready-for-agent

- [ ] `tests/integration/bot/feishu-parity.test.ts` (or a sibling) parameterized over `AGENT_KINDS`: live vs backfilled message → identical outbound sequence; prompt differs only by the single hint line; `replyTo` is the original missed message; topic groups reply in-thread.
- [ ] `REQUIRED_BACKFILL_EVENTS` exported from the observability module; a static test asserts each event name is emitted somewhere in the bot layer and that the spec §13 table and the list agree.
- [ ] Static test: files implementing ledger / watermark / backfill / config defaults contain no registered agent kind literal, no `oc_`/`ou_`/`cli_` constants, and no profile or bot names; `preferences.backfill` defaults are byte-identical for every agent kind fixture.
- [ ] `docs/operations.md`: "Self-heal" section as described; README(.zh) link or one-line mention pointing at it; the existing docs contract test extended with two phrases from the new section so the wording cannot drift silently.
- [ ] `CONTEXT.md` glossary re-checked against the shipped code; any new word introduced by tickets 03–08 is added in this ticket if it was not already.
- [ ] `pnpm ci:local` green on the branch; no feature code beyond tests and docs is added here.
