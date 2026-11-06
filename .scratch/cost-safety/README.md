# Dual-track: cost-safety follow-ups

Docs track for the cost-safety gaps left after PR #47: run-tree stop (R6), one absolute run budget (R5), bounded outbox retries with quarantine (R3-tail), `listChats` permission state (R3b), cancellable queued runs (C1) and ledger retention vs replay window (R4). R1 and R2 are fixed inside PR #47 and are not here.

**Parked (2026-10-17, owner's request).** Written and parked; do not claim, implement, open the code PR or dispatch an agent until the owner un-parks it. Spec: [docs/specs/cost-safety.md](../../docs/specs/cost-safety.md).

Tickets below are tracer-bullet slices of that Spec. They are not product code.

## Tracks

| Track | Branch | PR | What it may contain |
| --- | --- | --- | --- |
| Docs (this) | `docs/cost-safety` | **#48** (draft, parked) | Spec, tickets, this README, delivery-note placeholders |
| Code | `feat/cost-safety` | not opened | Product code + tests only (open empty after un-park and after PR #47 merges) |

Do **not** merge this docs PR to `master` as a substitute for the feat PR. Do **not** open a feature/code PR from this branch. Do **not** copy `.scratch/` scaffolding, Spec files, or delivery-note templates onto the feat branch.

## Priority order

Honest priorities from the reachability judgments in the Spec (*Findings in scope*). Nothing here is P0/P1; nothing here blocks PR #47.

1. **01** R6 run-tree stop — P2 (descendant survival really happens; cost only if a descendant calls a model)
2. **02** R5 absolute run budget — P2 (rare trigger; it is the one bound on a single task's cost)
3. **03** R5 comment default timeout — P2 (small; closes the one entry point with no default)
4. **04** R3-tail outbox budget + quarantine — P3 (hot loop already fixed in #47; ~2 attempts/min remain; no model cost)
5. **05** R3b `listChats` permission state — P3 (real but slow; no model cost)
6. **06** C1 queued-run cancel — P3 (near-theoretical at 10 slots; cheap after 02)
7. **07** R4 ledger retention — P4 (near-theoretical at our traffic)

## Blocking graph

```
PR #47 merged
   ├──► 01-run-tree-stop
   ├──► 02-run-hard-budget ──► 06-queued-run-cancel
   ├──► 03-comment-default-timeout
   ├──► 04-outbox-attempt-budget
   ├──► 05-listchats-permission-state
   └──► 07-ledger-replay-retention
```

Parallel start set after un-park and #47 merge: 01, 02, 03, 04, 05, 07. 06 waits for 02 (same file, `src/runtime/run-executor.ts`).

## How an implementer claims a ticket (after un-park only)

1. Read the Spec. Then read **one** ticket whose blockers are all done.
2. Claim it **on this docs PR** (edit Status / delivery-note placeholder, or comment). Read-only claim: recording who is working it, not implementing here.
3. Branch work from the **code** PR branch (`feat/cost-safety`), not from this docs branch.
4. `/implement` (embeds `/tdd`) + in-session `/code-review` for that ticket only. One ticket per session. Push only to the code PR.
5. Fill the matching delivery-note placeholder; leave the docs PR as the ticket board.

Work the frontier: any ticket whose `Blocked by` is empty or already delivered. **Do not jump to implement until claiming.**

## Tickets

| # | Path | Title | Priority | Blocked by |
| --- | --- | --- | --- | --- |
| 01 | [issues/01-run-tree-stop.md](issues/01-run-tree-stop.md) | Run-tree stop: kill the process group/tree, confirm before release | P2 | PR #47 merged |
| 02 | [issues/02-run-hard-budget.md](issues/02-run-hard-budget.md) | Absolute run budget in `RunExecutor` for every entry point | P2 | PR #47 merged |
| 03 | [issues/03-comment-default-timeout.md](issues/03-comment-default-timeout.md) | Comment runs inherit the global timeout default | P2 | PR #47 merged |
| 04 | [issues/04-outbox-attempt-budget.md](issues/04-outbox-attempt-budget.md) | Outbox attempt budget, persisted back-off, quarantine + manual retry | P3 | PR #47 merged |
| 05 | [issues/05-listchats-permission-state.md](issues/05-listchats-permission-state.md) | `listChats` permanent 401/403 → permission-needs-action | P3 | PR #47 merged |
| 06 | [issues/06-queued-run-cancel.md](issues/06-queued-run-cancel.md) | Queued runs cancellable; re-check before spawn | P3 | 02 |
| 07 | [issues/07-ledger-replay-retention.md](issues/07-ledger-replay-retention.md) | Ledger retention aligned with the replay window | P4 | PR #47 merged |

## Delivery-note placeholders

Fill these on the **feat** side; keep the files on this docs PR as the record.

| Ticket | Placeholder |
| --- | --- |
| 01 | [delivery-notes/01-run-tree-stop.md](delivery-notes/01-run-tree-stop.md) |
| 02 | [delivery-notes/02-run-hard-budget.md](delivery-notes/02-run-hard-budget.md) |
| 03 | [delivery-notes/03-comment-default-timeout.md](delivery-notes/03-comment-default-timeout.md) |
| 04 | [delivery-notes/04-outbox-attempt-budget.md](delivery-notes/04-outbox-attempt-budget.md) |
| 05 | [delivery-notes/05-listchats-permission-state.md](delivery-notes/05-listchats-permission-state.md) |
| 06 | [delivery-notes/06-queued-run-cancel.md](delivery-notes/06-queued-run-cancel.md) |
| 07 | [delivery-notes/07-ledger-replay-retention.md](delivery-notes/07-ledger-replay-retention.md) |

## Evidence rules

- Cloud / CI: behavioural tests with fake CLI / fake agent / fake transport and fake timers (`tests/helpers/*`). CI matrix is macOS, Ubuntu and Windows; ticket 01 must pass on all three.
- **No real model cost.** No real CLI binary, no network, no live bridge, no real Feishu messages; `HOME` in a temp dir. Process tests use a harmless local counter, never a model call.
- Real-Feishu (E-level) checks are optional, local, on an isolated test profile with a tester-side hard cap; never against production identities, permissions or journals.
- No product code on this docs PR. No Feishu ids or secrets in any file (redact to the last 4 characters if one must be quoted).
- Forbidden "fixes": raising or removing the concurrency cap as a budget; disabling backfill; deleting outbox items to stop retries; a global `pkill`/name-based kill; per-entry-point budgets instead of the shared executor.
