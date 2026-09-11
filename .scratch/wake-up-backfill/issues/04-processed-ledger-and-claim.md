# 04: Processed ledger + claim — exactly-once intake across restart

**What to build:** The bot never runs the same `message_id` twice, no matter how many times or by which path it arrives — a WS redelivery, the same event reaching both the old and the new bridge during a `controls.restart()` (connect-before-disconnect), or (later) a backfill hand-off. A per-profile **processed ledger** (`backfill-state.json`, schema v1, in the profile directory next to `sessions.json`) is owned by the supervisor's managed profile and injected into every bridge like `sessions`, so it survives restarts and has a single writer. `intakeMessage` performs a synchronous **claim** on entry; a message that is gated out releases the claim, an accepted one (queued or handled as a command) is recorded and persisted. The loser of a duplicate logs `intake.skip-duplicate`. Live behaviour is otherwise unchanged. This slice is demoable alone: deliver one message id twice across a `/reconnect` and observe one run.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Ledger document: `{ schemaVersion: 1, lastLiveAt?, lastBackfillEnd?, processed: { [messageId]: createTimeMs } }`, written atomically with mode 0o600 through a serial persist queue; `load()` on start, `flush()` on profile shutdown, persistence failures surfaced the way other stores surface them.
- [ ] Loader follows CONTEXT.md persistence rules: ENOENT → empty; corrupt or unknown future `schemaVersion` → warn `backfill.ledger-load-failed`, run with an empty in-memory ledger, **never overwrite** the original file.
- [ ] Ledger instance is created once per managed profile in the supervisor and passed through `StartChannelDeps`; a `controls.restart()` reuses the same instance (test: two bridges, one ledger, one file writer).
- [ ] `claim(messageId)` is synchronous and is the first thing `intakeMessage` does; returns `false` when the id is processed or currently claimed. `release(messageId)` on gate-out; `record(messageId, createTime)` on acceptance (after `pending.push` or when `tryHandleCommand` returns handled).
- [ ] Duplicate path logs `intake.skip-duplicate` with `msgId`, `scope`, `source: 'ws'` (source value becomes `'backfill'` in ticket 07); metric `intake_duplicate_dropped` tagged by source.
- [ ] Pruning: entries with `createTime < now − 2 × lookbackMs` (12 h with spec defaults; use the constant until ticket 06 makes it configurable) dropped on load and after each record burst; hard cap 5000 ids, evict oldest.
- [ ] Tests (B2 mirror orders, B6): same id twice within one bridge → one `queued`, one `skip-duplicate`; same id across restart → one run; a gated-out message does not end up in the file; ledger survives `controls.restart()`; corrupt file is left untouched.
- [ ] `/doctor` unchanged in this ticket (ticket 05 adds the line). No `agentKind` branching; no profile or host names.
