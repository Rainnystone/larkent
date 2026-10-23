# 07: Ledger retention aligned with the replay window

**What to build:** the backfill ledger's count cap may only evict ids older than the replay window; ids that backfill could still replay, and claimed (queued/running) ids, are never evicted for capacity. Above a hard ceiling, automatic replay stops with a warning instead of forgetting.

**Blocked by:** PR #47 merged

**Priority:** P4 — R4. Needs > 5000 admitted messages inside the 6 h lookback plus one chat failing persistently. Near-theoretical for our traffic; do it before any multi-group / high-traffic rollout.

**Status:** parked

## Parent

[docs/specs/cost-safety.md](../../../docs/specs/cost-safety.md) — D7, D8; Findings R4.

## What to build

Today (`99480d2`): `BackfillLedger.record` (`src/bot/backfill-ledger.ts:79-86`) calls `prune`, which drops ids older than `2 × lookback` and then, above `BACKFILL_LEDGER_MAX_IDS = 5000` (`:8`), evicts the oldest by `createTime` (`:213-227`). An old in-window @ is therefore re-admitted by each incomplete scan, recorded, and evicted again (verification: 4 scans → 4 admissions).

Change:

- `prune` takes the live lookback (same source backfill uses) and evicts for capacity only ids with `createTime < now − lookbackMs`. Claimed ids are never evicted.
- Hard ceiling (proposed 50 000) on in-window ids: above it, `claim` for backfill-origin messages returns "capacity" instead of admitting, the scan is marked incomplete, and `ledger-capacity` is logged once per crossing. Live intake keeps working.
- No change to the persisted document shape beyond what pruning needs; no outbound recording.

## Acceptance criteria

- [ ] Red first: ledger seeded with 5000 newer processed ids, one older in-window processed human @, one other chat failing every scan; 4 scans → the old id is admitted 4 times on the merged #47 tree.
- [ ] After: the same 4 scans admit it 0 times; `has(old)` stays `true`.
- [ ] Ids older than the lookback are still evicted by the cap; the `2 × lookback` time prune still applies.
- [ ] A claimed (queued) id is not evicted under capacity pressure.
- [ ] Above the hard ceiling: backfill admits nothing new, logs `ledger-capacity` once, scan stays incomplete; live intake still accepted.
- [ ] Retrying the failing chat does not re-admit messages from chats that already succeeded.
- [ ] `pnpm ci:local` green; delivery note filled.

## Out of scope

- Outbound ledger (backfill-self-echo D3).
- Changing lookback defaults; per-chat partitioned ledgers (possible later).
- Recovery cadence (R1, in #47).

## Blocked by

- PR #47 merged
