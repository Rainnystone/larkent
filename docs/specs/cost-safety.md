# Spec: Cost-safety follow-ups (outbox budget, permission state, ledger retention, run budget, run-tree stop, queued cancel)

Status: **parked** (docs track). Written and parked at the owner's request on 2026-10-17 (UTC+8): do not claim, implement, open a code PR or dispatch an agent until the owner un-parks it. When un-parked, the status becomes ready-for-agent and the locked decisions below apply.
Written 2026-10-17 from two inputs: an external cost/loop audit (baseline `master@426f670` + PR #47 `@e6fce75`; not committed) and our independent verification of each finding on PR #47 head `99480d2` (fake agent / fake transport only; no real CLI, model or Feishu traffic). Line references below are against `99480d2`; PR #47 has since moved to `7796b2c`, which only changes tests, so the `src/` references still hold.

This document is the destination. Tickets under `.scratch/cost-safety/issues/` are disposable execution slices. Implementers claim tickets from the docs draft PR; they push product code only to a separate feat PR (not opened yet).

**Out of scope here: R1 and R2.** R1 (recovery self-trigger: `recovered → queued` skips the 1–30 s back-off) and R2 (automatic failure notices @-mentioning a bot initiator → bot↔bot ping-pong) were introduced or made reachable by PR #47. They are being fixed inside PR #47 and are not repeated here.

---

## Problem Statement

Owner intent: one task must have a **bounded** cost, and "stop" must mean stopped. After PR #47, the self-sustaining loops that matter (R1, R2) are being closed in #47 itself. What remains is a set of independent safety gaps. Each has a real mechanism, confirmed in isolation, but most are hard to reach on our deployment (a few groups, low traffic, Bot Arena with several bots, default config). This Spec records each gap with an honest reachability judgment so it can be fixed at the right priority, not as an emergency.

"Unbounded" below means the program has no exit condition of its own; it does **not** mean a bill has been observed. Feishu request repetition costs quota, rate limit headroom, CPU and logs. It is not the same thing as model spend.

### Findings in scope

| ID | Gap | Verification on `99480d2` | Real-world reachability (our deployment) | What already catches it | Priority |
|---|---|---|---|---|---|
| R6 | POSIX stop signals only the direct CLI child; descendants survive while the slot and the active-run record are released | confirmed (S + existing process test that **pins** descendant survival) | Descendant survival **does** happen (bash tool, background script). It only costs money when the descendant itself calls a model (e.g. an agent-spawned `claude -p`), which is rare | Nothing on POSIX. Windows: the existing test comment claims TerminateProcess / job objects reap descendants; not independently verified | **P2** |
| R5 | No absolute run budget. Idle timeout re-arms on every event; tool calls pause it for up to 60 min; comment runs have no default timeout; `/doctor` has none; meetings do not use the IM watchdog | confirmed (S + existing tests that pin "comment default = no timeout") | Only when an agent keeps emitting events while flailing. The bridge does not cause it; rare | IM idle default 15 min (#47); 60 min tool pause cap; per-CLI limits (not verified); concurrency cap 10 (bounds parallelism, not total) | **P2** |
| R3-tail | Outbox: a staged reply/notice that keeps failing with a `local` / unknown error is retried forever. #47's `OUTBOX_IDLE_MS` (60 s) removed the 50 ms hot loop, leaving ~2 send attempts per minute until process restart; no attempt budget, no terminal state | hot loop **already-fixed** (600 s fake time: 22 attempts vs 11 961 on `e6fce75`); remaining slow loop confirmed | Needs a persistent local or unclassified error on one item. Plausible but uncommon. No model cost; a few API calls/min, CPU, logs | `OUTBOX_IDLE_MS`; recognised permanent 4xx already go terminal (`rejected`) | **P3** |
| R3b | `listChats` permanent 403 / 401 is treated as an incomplete scan, so recovery rescans on 1→2→4→8→16→30 s back-off, then every 30 s, forever | confirmed (S + M) | Real channel: the app loses `im:chat` read permission or is removed from tenant scope. Slow (≤ 2/min), no model cost | Back-off cap 30 s; 6 h lookback bounds the history range, not the retry lifetime | **P3** |
| C1 | A run waiting for a pool slot cannot be stopped (`interrupt` returns `false`) and is still spawned after its policy expired | confirmed (S + M: ProcessPool(1), spawn count 2) | Needs all 10 slots (`maxConcurrentRuns` default) occupied. Near-theoretical at our scale | `expiresAt` checked once before waiting; default policy TTL 5 min | **P3** (cheap; do after R5 in the same file) |
| R4 | Dedup ledger cap (5000 ids, evict-oldest-by-createTime) is smaller than what the replay window can hold; an old in-window @ is re-admitted on each incomplete scan, recorded, then evicted again | confirmed mechanism (S + M: 4 scans → 4 admissions of the same id) | Needs > 5000 admitted messages inside the 6 h lookback **and** one chat failing persistently. Near-theoretical for us | 6 h lookback caps replay age; 600 ms debounce may merge repeats (does not prevent them) | **P4** |

Evidence levels: S = source fact, M = isolated simulation with real modules and fake transport/agent, E = real Feishu. Nothing in this table is E.

Sources (paths/lines on `99480d2`):

- R6: `src/agent/runner/jsonl-cli-runner.ts:83` (`detached: true`), `:196-224` (`child.kill('SIGTERM')` then `SIGKILL`, direct child only); `tests/process/runner-stop-drain.test.ts` (~`:276-288`, asserts the POSIX descendant is still alive while `pool.active === 0` and `activeRuns` is empty).
- R5: `src/config/schema.ts:308-321` (`DEFAULT_RUN_IDLE_TIMEOUT_MINUTES = 15`, `0` disables); `src/bot/channel.ts:1678-1689` (IM idle resolution), `:2643-2681` (watchdog re-arms on every event, `TOOL_IDLE_PAUSE_CAP_MS` 60 min); `src/bot/comments.ts:203-235`, `:759-769` (`commentRunTimeoutMs` reads only the scope override; unset → no deadline); `src/commands/index.ts:1127-1210` (`/doctor` submits with `nowait: true` and consumes events with no deadline); `src/meeting/orchestrator.ts` (consumes `execution.subscribe()` with no watchdog; meetings are off by default).
- R3-tail: `src/bot/channel.ts:148-151` (`OUTBOX_SWEEP_MS` 50, `OUTBOX_IDLE_MS` 60 000), `:619-661` (sweep: no progress → 60 s; reject → exponential/reset back-off), `:703-713` (`recover()` resets the delay and sweeps at once); `src/bot/turn-journal.ts:442-560` (`redeliver`: `local` is logged and the item stays `staged`), `:674-692` (`prune` never removes non-terminal entries).
- R3b: `src/bot/backfill.ts:123-130` (`chats-fetch-failed` → `chatsFetchFailed = true`), `:202-215` (incomplete → return `false`); per-chat 4xx is already isolated by `isNonRetryableChatStatus` (`:299`, `:539`, `:723`), `listChats` is not.
- C1: `src/runtime/run-executor.ts:84-100` (`expiresAt` checked at `:86`; `reserve` at `:96`; `await pool.acquire()` at `:100`; no re-check after); `src/bot/active-runs.ts:127` (`interrupt` sees registered handles only). Only `/doctor` uses `nowait`.
- R4: `src/bot/backfill-ledger.ts:8` (`BACKFILL_LEDGER_MAX_IDS = 5000`), `:79-86` (`record` → `prune`), `:213-227` (cap evicts oldest by createTime), `:48` (time horizon `2 × lookback`); `src/bot/backfill.ts:416` (only processed check); `src/bot/channel.ts:1079`, `:1275-1278` (intake claims/records via the ledger only).

---

## Solution

1. **Stop the whole run tree** (R6). Each run owns a process group (POSIX) or process tree / job (Windows). Stop sends soft then hard termination to the **group**, and the slot and active-run record are released only after the group is confirmed gone.
2. **One absolute run budget in `RunExecutor`** (R5). Every run, whatever its entry point, gets a wall-time budget and a step budget enforced by the shared executor, independent of idle. Comment runs also inherit the global idle default instead of "no timeout".
3. **Bounded outbox retries with quarantine** (R3-tail). Each staged item carries a persisted attempt count, `nextAttemptAt` and first-failure time. `local` / unknown failures back off and stop after a fixed budget; the item becomes `quarantined` with its body kept for a manual retry.
4. **Permission-needs-action state for `listChats`** (R3b). A permanent 401/403 on `listChats` parks automatic rescans in a visible state instead of retrying every 30 s forever; the outage window is preserved.
5. **Queued runs are cancellable and re-checked** (C1). A run waiting for a pool slot is visible to `/stop` / `stopAll`, and cancellation and expiry are re-checked after the slot is acquired, before spawn.
6. **Ledger retention matches the replay window** (R4). Ids that backfill could still replay are never evicted by the count cap; capacity pressure stops automatic replay with a warning instead.

---

## Seams

Prefer existing seams. Do not add a parallel executor, a second ledger, or a second outbox.

1. **Runner stop seam (R6).** `runJsonlCli` / `stopChild` in `src/agent/runner/jsonl-cli-runner.ts`. The child is already `detached: true` (its own process group on POSIX), so signalling `-pid` is available without changing spawn. Startup identity (`readProcessStartMs`) is already recorded; keep using it before any signal (also for journal orphan reaping, `src/bot/turn-journal.ts`).
2. **Executor seam (R5, C1).** `RunExecutor.submit` in `src/runtime/run-executor.ts` is the one path every entry point uses (IM via `run-flow.ts` / `channel.ts`, comments, meetings, `/doctor`, card dispatcher). Budget enforcement and the post-acquire re-check live here, not per entry point. `ActiveRuns` (`src/bot/active-runs.ts`) owns reservation and interrupt; a queued handle belongs there.
3. **Config seam (R5).** `src/config/schema.ts` next to `getRunIdleTimeoutMs` (same clamp/`0` conventions); per-scope overrides stay in `SessionStore` as today.
4. **Comment timeout seam (R5).** `commentRunTimeoutMs` in `src/bot/comments.ts:759-769`.
5. **Outbox seam (R3-tail).** `TurnJournal.redeliver` and the reply/notice item state (`OutboxItemState`, `TurnReply`, `TurnNotice` in `src/bot/turn-journal.ts`) plus the sweep scheduler in `src/bot/channel.ts:619-713`.
6. **Backfill / recovery seam (R3b).** The `listChats` catch in `runBackfill` (`src/bot/backfill.ts:123-130`) and the existing error classifier (`src/bot/feishu-error.ts`, `isNonRetryableChatStatus`). Recovery scheduling (`src/bot/recovery.ts`) only needs to learn "not retryable automatically".
7. **Ledger seam (R4).** `BackfillLedger.prune` in `src/bot/backfill-ledger.ts`.

---

## User Stories

1. As an operator, I want `/stop` (and the idle watchdog, `stopAll`, shutdown) to stop every process a run started, so that nothing keeps working, or spending, after the bot says it stopped.
2. As an operator, I want a run's slot released only after its process tree is confirmed gone, so that the concurrency cap reflects reality.
3. As an operator, I want stop to never kill another run's or another user's processes, so that a reused PID cannot become collateral damage.
4. As an operator, I want every run to have an absolute wall-time and step budget, whatever started it (IM, comment, meeting, `/doctor`), so that a flailing agent that keeps emitting events still stops.
5. As a chat user, I want a run that hits its budget to end with a clear notice, so that I know it was cut, not lost.
6. As an operator, I want comment runs without a per-scope override to inherit the global default, so that comments are not the one entry point without a bound.
7. As a chat user, I want a reply that could not be delivered to be retried a bounded number of times and then kept, not dropped, so that my answer is never silently discarded.
8. As an operator, I want quarantined replies visible and retryable by hand, so that I can deliver them once the cause is fixed.
9. As an operator, I want a permanent permission error on chat listing to show up as "permission needs action" instead of a silent 30 s rescan loop, so that I fix the permission rather than discover the log noise.
10. As an operator, I want backfill to catch up automatically once the permission is restored, so that the outage window is not lost.
11. As a chat user, I want `/stop` to cancel my request even while it is still waiting for a free slot, so that it never starts later.
12. As an operator, I want a run whose policy expired while queued to be rejected instead of spawned, so that stale work does not consume budget.
13. As a chat user, I want a message the bot already handled never to be handled again by backfill inside the replay window, however busy other chats are.

---

## Implementation Decisions

Proposed 2026-10-17 for owner sign-off on un-park. Numbers marked *(proposed)* are defaults the owner may change on this PR; the shape of each decision is what the tickets build.

**D1 — Run-tree stop (R6).** POSIX: stop signals the run's process group (`process.kill(-pgid, 'SIGTERM')`, then `SIGKILL` after `stopGraceMs`), not only the direct child. The pgid is the child's pid (already `detached: true`); before signalling, verify that pid still has the recorded start time (existing identity check), and never signal a group the run does not own. Windows: kill the process tree (job object or `taskkill /PID <pid> /T /F`, implementer's choice) with the same identity check. Stop resolves, and the pool slot / active-run record / scope reservation are released, only **after** the group is confirmed empty (bounded wait; on timeout keep today's `RunCleanupFailed` path and log the surviving pids). Work that deliberately escapes the group (`setsid`, double fork, external services) is out of scope and documented as a known limitation.

**D2 — Absolute run budget in `RunExecutor` (R5).** `submit` arms a wall-time deadline at spawn and counts steps (one step = one `tool_use` event, *proposed*) from the run's event stream. On either limit the executor stops the run through the same stop path as `/stop` (so D1 applies), records a new stop request `{ type: 'run-budget', limit: 'wall' | 'steps' }` (`src/bot/run-outcome.ts`, alongside `bridge-idle-watchdog`) and the entry point sees a normal terminal outcome; the chat gets one notice naming the budget that was reached. Whether that notice offers 继续 is for the owner *(proposed: yes, because 继续 is an explicit human re-authorisation)*. The budget is independent of the idle watchdog: no event can extend it. Defaults *(proposed)*: `runMaxWallMinutes` = 120 (clamp 1–720), `runMaxSteps` = 400 (clamp 10–5000); `0` disables, matching `runIdleTimeoutMinutes`. `/doctor` uses a fixed tighter wall budget *(proposed: 5 min)*. A human 继续 (button or typed) is an explicit re-authorisation and starts a fresh budget; there is no automatic resume path, so no other path may start one. Token/money budgets are out of scope (not all CLIs report usage in-run); the docs must say the step/wall budget is the bound and usage is not.

**D3 — Comments inherit the global default (R5).** In `commentRunTimeoutMs`, an unset scope/thread override falls back to `getRunIdleTimeoutMs(cfg)` (15 min unless configured; `0` still disables). The comment deadline semantics stay as today (deadline from policy `ttlMs`); this is flagged because it is an absolute 15 min for comments vs a 15 min idle for IM. D2 applies to comments as well.

**D4 — Outbox attempt budget and quarantine (R3-tail).** Each reply and notice item persists `attempts`, `nextAttemptAt` and `firstFailedAt` (optional fields; an old journal file must load). A `local` or unclassified failure increments `attempts` and sets `nextAttemptAt` with exponential back-off *(proposed: 60 s doubling, cap 30 min)*. Recovery and sweep triggers must not attempt an item before its `nextAttemptAt` (same rule R1 applies to recovery in #47). After *(proposed)* 8 attempts the item becomes `quarantined`: a new `OutboxItemState`, not retried automatically, body kept, never pruned by the count cap (age cap 7 d as today), one warn log `outbox-quarantined` with `turnId`, item kind, attempts and the last error class. `link` failures keep today's behaviour (retry on recovery, count but do not quarantine). Recognised permanent rejects stay `rejected` as today. Manual retry: an owner-only command re-stages quarantined items once with a fresh budget *(proposed name: `/retry-delivery`; owner may prefer listing them in `/doctor` with a button)*. Exactly-once (PR #47 I1) is unchanged: a retried item reuses its stored `deliveryId` and read-back.

**D5 — `listChats` permission-needs-action (R3b).** A `listChats` failure with HTTP 401/403 (or the Feishu permission business codes the classifier already treats as permanent) sets backfill state `needs-permission` instead of a plain incomplete scan: the outage window (`incompleteFrom`) is preserved; automatic recovery scans stop scheduling retries; one warn log `chats-permission-needed` (status, code; no ids) on entering the state; `/doctor` reports it. The state is left by: process restart, config reload/credential swap, a successful `listChats` from a low-frequency re-probe *(proposed: every 30 min)*, or `/doctor`. On leaving it, one normal backfill runs over the preserved window (still clamped by lookback). Transient errors (429, 5xx, network, timeout, no status) keep today's back-off. An owner DM on entering the state is *not* part of this decision (owner may add it).

**D6 — Queued runs are cancellable; re-check before spawn (C1).** While `submit` waits on `pool.acquire()`, the run has a queued handle in `ActiveRuns` under its scope: `interrupt(scope)` and `stopAll` return `true` and cancel it; the waiter leaves the pool queue without consuming a slot. After acquiring a slot and again immediately before `agent.run`, `submit` re-checks cancellation, `policy.expiresAt` and `newRunsPaused()`; any failure releases slot and scope and throws `RunRejected` (`cancelled` / `policy-expired` / `reconnect-in-progress`). The debounce queue (`PendingQueue.cancelAll`) is out of this decision; it covers only the executor wait.

**D7 — Ledger retention = replay window (R4).** The count cap may evict only ids whose `createTime` is older than the replay window (`now − lookbackMs`, the same lookback backfill uses), plus the existing `2 × lookback` time prune. Ids inside the window, and ids currently claimed (queued/running), are never evicted for capacity. If in-window ids alone exceed a hard ceiling *(proposed: 50 000)*, the ledger stops admitting backfill replays (live intake continues), marks the scan incomplete, and logs `ledger-capacity` once per crossing; it does not evict. No new persisted schema beyond what pruning needs; no outbound recording (backfill-self-echo D3 still holds).

**D8 — Nothing here changes R1/R2 behaviour or blocks PR #47.** All tickets start from `master` **after** PR #47 merges (they touch files #47 rewrites, and R3-tail/R3b only exist in #47's outbox/recovery code).

### Notes for implementers (not new decisions)

- **Do not reuse the old audit's SHA conclusions mechanically.** Re-run each ticket's red test on the merged tree first; if the gap is already gone, deliver the test as a regression pin and say so in the delivery note.
- **Windows (D1).** The comment in `runner-stop-drain.test.ts` asserts Windows reaps descendants; nobody has verified that. CI runs `windows-latest`, so the cross-platform assertion in ticket 01 will tell.
- **Counting (D2).** `usage` events are not steps. Count from the executor's event stream, not from Feishu output, so a run that is hidden from the chat is still counted.
- **Pruning (D4).** `TurnJournal.prune` only drops `TERMINAL_PRUNE` statuses by count; check that `quarantined` items are neither dropped by count nor block pruning of other entries.
- **Classifier (D5).** Use `src/bot/feishu-error.ts`; do not add a second classifier. 401/403 on `listChats` currently look like `rejected` to the link (link stays up), which is correct and stays.

---

## Testing Decisions

- Behavioural tests through public seams only: `runJsonlCli` / `RunExecutor` / `ActiveRuns` / `ProcessPool`, `startChannel` + `TurnJournal`, `runBackfill` + `BackfillLedger`, the comment handler. Prior art: `tests/process/runner-stop-drain.test.ts`, `tests/integration/bot/idle-lifecycle.test.ts`, `tests/integration/comments/comment-lifecycle.test.ts`, outbox-gating and recovery tests from #47, `tests/unit/bot/backfill.test.ts`.
- Fixtures: `tests/helpers/fake-agent.ts`, `scripted-jsonl-cli.ts`, `fake-executable.ts`, `recording-lark-channel.ts`, `sdk-feishu-errors.ts`, `tmp-profile.ts`. Fake timers for every budget/back-off case.
- **No real model cost, no real Feishu.** No real CLI binary, no network, no live bridge, `HOME` pointed at a temp dir. Process tests use harmless local counters (a descendant that appends to a temp file), never a model call.
- Every ticket starts red (fails on the merged #47 tree for the stated reason) and ends with `pnpm ci:local` green on macOS, Ubuntu and Windows CI.
- Tests that pin today's unsafe behaviour (POSIX descendant alive after stop; comment default no timeout) are **flipped**, not deleted.

---

## Out of Scope

- R1 (recovery self-trigger) and R2 (bot↔bot notice ping-pong): fixed in PR #47.
- Cross-bot causal-chain hop budgets beyond #47's R2 fix.
- Token / money budgets, per-user or per-day quotas, spawn-rate limits (future Spec if wanted).
- Work that deliberately leaves the run's process group (`setsid`, daemons, remote jobs).
- Real-Feishu (E-level) fault injection; it may be done later on an isolated test profile with a tester-side hard cap, never against production identities.
- Outbound-id ledger; disabling backfill; changing lookback defaults.

---

## Acceptance Criteria (Spec-level)

- [ ] After `/stop`, the idle watchdog, `stopAll` and shutdown, a fake CLI's descendant counter stops increasing on macOS, Linux and Windows CI, and the pool slot is released only after that.
- [ ] Stop never signals a process group whose leader's start time does not match the run.
- [ ] A fake agent that emits a legal event every few seconds forever is stopped at the wall budget; one that emits `tool_use` in a loop is stopped at the step budget; both through IM, comment, meeting and `/doctor` entry points.
- [ ] A comment run with no override is bounded by the global default; explicit `0` still disables.
- [ ] A staged item failing with `TypeError`, unknown error or missing receipt is attempted at most the budgeted number of times (persisted across restart), then `quarantined` with body intact; manual retry delivers it exactly once.
- [ ] A persistent `listChats` 403 produces bounded attempts, a `needs-permission` state and no 30 s loop; after the permission returns, one backfill covers the preserved window.
- [ ] A run queued on a full pool is cancelled by `/stop` (`interrupt` → `true`) and never spawns; a queued run whose policy expired is rejected, not spawned.
- [ ] With the ledger at capacity, an already-handled in-window message is never re-admitted, however many incomplete scans run.
- [ ] No `src/` change on this docs PR; no Feishu ids or secrets in any file.

---

## Tickets

One ticket per session; vertical slices; listed in priority order.

| # | Title | Finding | Priority | Blocked by |
| --- | --- | --- | --- | --- |
| 01 | Run-tree stop: kill the process group/tree, confirm before release | R6 | P2 | PR #47 merged |
| 02 | Absolute run budget (wall time + steps) in `RunExecutor` for every entry point | R5 | P2 | PR #47 merged |
| 03 | Comment runs inherit the global timeout default | R5 | P2 | PR #47 merged |
| 04 | Outbox attempt budget, persisted back-off, quarantine + manual retry | R3-tail | P3 | PR #47 merged |
| 05 | `listChats` permanent 401/403 → permission-needs-action state | R3b | P3 | PR #47 merged |
| 06 | Queued runs cancellable; re-check cancel/expiry before spawn | C1 | P3 | 02 (same file) |
| 07 | Ledger retention aligned with the replay window | R4 | P4 | PR #47 merged |

---

## Dual-track

- **Docs (this):** Spec + tickets + delivery-note placeholders only. Do not merge as product. Parked.
- **Code:** separate `feat/cost-safety`, **not opened**. Open it (empty) only when the owner un-parks this Spec and PR #47 has merged.
