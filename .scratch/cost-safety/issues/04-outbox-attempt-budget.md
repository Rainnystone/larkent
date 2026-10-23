# 04: Outbox attempt budget, persisted back-off, quarantine + manual retry

**What to build:** each staged reply/notice persists `attempts`, `nextAttemptAt` and `firstFailedAt`. `local`/unclassified failures back off exponentially and, after a fixed budget, the item becomes `quarantined` (body kept, not retried automatically, retryable by the owner) instead of being retried about twice a minute forever.

**Blocked by:** PR #47 merged

**Priority:** P3 — R3-tail. The 50 ms hot loop is already fixed by #47 (`OUTBOX_IDLE_MS`; 600 s fake time: 22 attempts vs 11 961 before). What remains needs a persistent local or unclassified error on one item; ~2 attempts/min until restart; no model cost.

**Status:** parked

## Parent

[docs/specs/cost-safety.md](../../../docs/specs/cost-safety.md) — D4, D8; Findings R3-tail; Notes for implementers (pruning).

## What to build

Today (`99480d2`):

- `TurnJournal.redeliver` (`src/bot/turn-journal.ts:442-560`): `rejected` → item terminal; `link` → throw (sweep backs off, recovery retries); `local` → log `resend-failed` / `notice-resend-failed` and leave `staged`.
- Sweep (`src/bot/channel.ts:619-661`): no progress → re-arm in 60 s; `recover()` (`:703-713`) resets the delay and sweeps immediately. No per-item memory; restart resets everything.
- `prune` (`:674-692`) only drops terminal entries.

Change:

- Optional fields on `TurnReply` and `TurnNotice`: `attempts`, `nextAttemptAt`, `firstFailedAt`, `lastErrorClass`. Old journal files load unchanged (no `schemaVersion` bump unless the loader requires it).
- `local` / unclassified failure: `attempts += 1`, `nextAttemptAt = now + backoff` (proposed 60 s doubling, cap 30 min). `link` failure: count, but keep recovery-driven retry and never quarantine on `link` alone.
- `redeliver` skips items whose `nextAttemptAt` is in the future, for every trigger (sweep timer, `recover()`, startup). The sweep arms its timer for the earliest `nextAttemptAt` instead of a flat 60 s.
- After the budget (proposed 8 attempts) → `OutboxItemState` `quarantined`; log `outbox-quarantined` (`turnId`, kind, attempts, `lastErrorClass`; no body, no ids beyond `turnId`). Not dropped by the count cap; existing 7-day age cap applies.
- Manual retry: owner-only command (proposed `/retry-delivery`) re-stages every quarantined item once with a fresh budget and reports how many; non-owners get the standard refusal. Delivery reuses the stored `deliveryId` and read-back (exactly-once from #47).
- One bad item must not starve others: a quarantined or backing-off item does not block the rest of the pass.

## Acceptance criteria

- [ ] Red first: persistent `TypeError` on resend, 600 s fake time → more than 8 attempts on the merged #47 tree (expected ~22).
- [ ] After: `TypeError`, status-less unknown error and missing receipt each → attempts follow the back-off schedule and stop at the budget; item `quarantined` with markdown intact.
- [ ] Restart mid-budget (reload journal from disk via `tmp-profile`) → attempt count and `nextAttemptAt` continue; no immediate burst.
- [ ] A `recovered` event during back-off does not attempt the item early.
- [ ] Two staged items, one failing persistently, one healthy → the healthy one is delivered exactly once on the first pass.
- [ ] Transient error that clears after 2 attempts → delivered exactly once, no quarantine.
- [ ] Recognised permanent 4xx still goes `rejected` immediately (existing outbox-gating tests green).
- [ ] `/retry-delivery` by the owner → quarantined item delivered once (recording channel), state `sent`; by a non-owner → refused, item unchanged.
- [ ] An old journal file without the new fields loads and delivers its staged items once.
- [ ] `pnpm ci:local` green; delivery note filled.

## Out of scope

- Outbox `link` / 429 behaviour beyond counting (owned by #47).
- An owner DM on quarantine (owner may add later).
- `listChats` permission state (05).

## Blocked by

- PR #47 merged
