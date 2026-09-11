# Wake-up @mention backfill — ticket index

Source spec: [docs/specs/wake-up-backfill.md](../../docs/specs/wake-up-backfill.md). Vocabulary: [CONTEXT.md](../../CONTEXT.md) § "Self-heal and backfill".

Tickets are tracer-bullet vertical slices: each is demoable on its own and sized for one fresh agent context. Numbered in dependency order. Every ticket obeys the product law in spec §0: standalone (no external poller, watcher or host routine), runtime equality (no agent-kind branching, no named profiles/bots), bot identity only.

Problem A (double outbound) and Problem B (missed @mentions while offline) are separate tracks that only meet at the "one turn → one post" principle; do not merge their tickets.

## Tickets

| NN | Ticket | Track | Blocked by |
|----|--------|-------|-----------|
| 01 | [Spike — verify Feishu history-API facts (V1–V3)](issues/01-verify-feishu-history-api-facts.md) | B | None |
| 02 | [Problem A — bridge owns the final reply (instructions + docs)](issues/02-bridge-owns-final-reply-instructions.md) | A | None |
| 03 | [Problem A — skip the bridge's final reply when the agent already delivered](issues/03-skip-final-reply-when-agent-already-delivered.md) | A | 02 |
| 04 | [Processed ledger + claim — exactly-once intake across restart](issues/04-processed-ledger-and-claim.md) | B | None |
| 05 | [Live watermark heartbeat + `/doctor` self-heal line](issues/05-live-watermark-heartbeat.md) | B | 04 |
| 06 | [`preferences.backfill` config block — defaults, kill switch, dry-run](issues/06-backfill-config-block.md) | B | None |
| 07 | [Backfill on connect — answer missed @mentions once, with a lateness hint](issues/07-backfill-on-connect.md) | B | 01, 04, 05, 06 |
| 08 | [Backfill on SDK `reconnected` — blips, coalescing, storm protection](issues/08-backfill-on-sdk-reconnected.md) | B | 07 |
| 09 | [Hardening — cross-agent parity, static contracts, operator docs](issues/09-hardening-parity-contracts-docs.md) | A+B | 07, 08 |

## Blocking graph

```
01 ─────────────┐
04 ──► 05 ──────┼──► 07 ──► 08 ──► 09
06 ─────────────┘                   ▲
02 ──► 03 ──────────────────────────┘  (03 is not a hard blocker of 09; 09 verifies A's docs wording if 03 has landed)
```

Parallel start set: 01, 02, 04, 06. Critical path: 04 → 05 → 07 → 08 → 09.

## Working agreement

- Read the spec section named in the ticket before starting; the ticket is the *what*, the spec is the *why* and the edge cases.
- Each ticket lands as its own PR against `master` with its own failing-first tests, and runs `pnpm ci:local` in that worktree (AGENTS.md).
- A ticket that discovers a spec gap amends `docs/specs/wake-up-backfill.md` and, if a new word is needed, `CONTEXT.md` in the same PR.
- Status values: `ready-for-agent` → `in-progress` → `done` (edit the ticket file's `**Status:**` line).
- Ticket 01 output goes to `notes/api-verification.md` in this directory.
