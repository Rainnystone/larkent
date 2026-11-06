# 03: Comment runs inherit the global timeout default

**What to build:** a comment run with no per-comment/per-thread override uses the global `runIdleTimeoutMinutes` default (15 min unless configured) instead of no timeout; an explicit `0` still disables.

**Blocked by:** PR #47 merged

**Priority:** P2 — R5 (comment part). Small; closes the one IM-like entry point that has no default bound. Reachability is the same as R5: rare.

**Status:** parked

## Parent

[docs/specs/cost-safety.md](../../../docs/specs/cost-safety.md) — D3; Findings R5.

## What to build

Today (`99480d2`): `commentRunTimeoutMs` (`src/bot/comments.ts:759-769`) returns `undefined` when no scope override exists; the caller (`:203-235`) then sets no `ttlMs` and no `commentExpiresAt`, so the run has no deadline. `tests/integration/comments/comment-lifecycle.test.ts` pins override = 1 min and override = 0 (off); the unset case is unbounded.

Change:

- When both run-scope and thread-scope overrides are unset, fall back to `getRunIdleTimeoutMs(controls.cfg)`; `undefined` from that (global `0`) keeps "no deadline".
- Keep today's comment deadline semantics (absolute from policy `ttlMs`, `nextCommentEvent`). The difference from IM idle semantics is flagged in the Spec (D3); do not change it here.
- Log line `comment timeout-watchdog` now also appears for the default case, with `source: 'default'` vs `'override'`.

## Acceptance criteria

- [ ] Red first: comment run, no override, global default unset, fake agent that never finishes → not stopped at 15 min on the merged #47 tree.
- [ ] After: stopped at 15 min (fake timers) with the existing comment timeout reply; agent stop called once.
- [ ] Global `runIdleTimeoutMinutes: 5` → comment stopped at 5 min.
- [ ] Global `runIdleTimeoutMinutes: 0` and no override → no deadline.
- [ ] Existing override = 1 and override = 0 tests unchanged and green.
- [ ] `pnpm ci:local` green; delivery note filled.

## Out of scope

- Switching comments to idle (re-arm on event) semantics.
- Absolute run budget (02).

## Blocked by

- PR #47 merged
