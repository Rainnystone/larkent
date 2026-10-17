# 06: Queued runs cancellable; re-check cancel/expiry before spawn

**What to build:** a run waiting in `RunExecutor` for a pool slot is visible to `/stop` and `stopAll` and can be cancelled; after the slot is acquired, cancellation, policy expiry and the new-runs pause are re-checked before spawn.

**Blocked by:** 02 (same file, `src/runtime/run-executor.ts`)

**Priority:** P3 — C1. Needs all `maxConcurrentRuns` slots (default 10) busy; near-theoretical for us. Cheap once 02 has landed in the same file.

**Status:** parked

## Parent

[docs/specs/cost-safety.md](../../../docs/specs/cost-safety.md) — D6, D8; Findings C1.

## What to build

Today (`99480d2`, `src/runtime/run-executor.ts:84-100`): `expiresAt` checked once (`:86`), scope reserved (`:96`), `await pool.acquire()` (`:100`), then spawn with no further expiry/cancel check. `ActiveRuns.interrupt` (`src/bot/active-runs.ts:127`) only sees registered handles, so `interrupt` on a queued scope returns `false`.

Change:

- While waiting, register a queued handle for the scope in `ActiveRuns` (or a queued set it owns) so `interrupt(scope)` returns `true` and `stopAll` includes it.
- Cancelling a queued run removes its waiter from `ProcessPool` without consuming a slot, releases the scope, and rejects `submit` with `RunRejected('cancelled', …)`.
- After `acquire()` and again right before `agent.run`: re-check cancellation, `policy.expiresAt <= now` (`policy-expired`) and `newRunsPaused()`; on failure release slot and scope.
- Callers already handle `RunRejected`; make sure the IM path does not post an error for `cancelled` (the user asked for it).

## Acceptance criteria

- [ ] Red first (pure in-memory, fake adapter, `ProcessPool(1)`): run A holds the slot; run B queued; `interrupt('B')` returns `false` and B spawns after A ends — on the merged #47 tree.
- [ ] After: `interrupt('B')` returns `true`; release A → B never spawns (spawn count 1); `submit(B)` rejects `cancelled`; pool `active` back to 0.
- [ ] `stopAll` with A running and B queued → both stopped, spawn count 1.
- [ ] B queued; fake clock passes `B.policy.expiresAt`; release A → B rejected `policy-expired`, never spawned.
- [ ] Pause new runs while B is queued; release A → B rejected `reconnect-in-progress`.
- [ ] A queued run that is not cancelled still spawns normally after A ends.
- [ ] `pnpm ci:local` green; delivery note filled.

## Out of scope

- The debounce `PendingQueue` (already has `cancelAll`).
- Pool size defaults; `nowait` semantics.

## Blocked by

- [02: Absolute run budget in `RunExecutor`](02-run-hard-budget.md)
