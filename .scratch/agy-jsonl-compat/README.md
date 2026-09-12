# Dual-track: agy JSONL compatibility

This folder is the **docs track** for Antigravity `stream-json` compatibility (official `tool` / `checkpoint` steps, empty SUCCESS after print-timeout, first-class `--print-timeout`).

Grill is closed. The Spec is [docs/specs/agy-jsonl-compat.md](../../docs/specs/agy-jsonl-compat.md). Tickets below are tracer-bullet slices of that Spec. They are not product code.

## Tracks

| Track | Branch | PR | What it may contain |
| --- | --- | --- | --- |
| Docs (this) | `cursor/agy-jsonl-compat-docs-c396` | **[#27](https://github.com/Rainnystone/larkent/pull/27)** (draft) | Spec, tickets, this README, delivery-note **placeholders** |
| Code (later) | a clean `feat/…` from latest `master` | a **separate** feat PR, opened later | Product code + tests only |

Do **not** merge this docs PR to `master` as a substitute for the feat PR. Do **not** open a feature/code PR from this branch. Do **not** copy `.scratch/` scaffolding, Spec files, or delivery-note templates onto the feat branch.

## How an implementer claims a ticket

1. Read the Spec. Then read **one** ticket whose blockers are all done.
2. Claim it **on docs PR [#27](https://github.com/Rainnystone/larkent/pull/27)** (edit the ticket Status / delivery-note placeholder, or comment on that PR). Read-only claim: you are recording who is working it, not implementing here.
3. Branch **from latest `master`**, not from this docs branch.
4. Implement only that ticket. Push code only to the feat PR.
5. Fill the matching delivery-note placeholder (evidence, residual risk) and point it at the feat PR. Leave the docs PR as the ticket board.

Work the frontier: any ticket whose `Blocked by` is empty or already delivered.

## Tickets

| # | Path | Title | Blocked by |
| --- | --- | --- | --- |
| 01 | [issues/01-recognize-tool-checkpoint.md](issues/01-recognize-tool-checkpoint.md) | Recognize official `tool` and `checkpoint` steps (parse only) | None |
| 02 | [issues/02-empty-success-timeout-hint.md](issues/02-empty-success-timeout-hint.md) | Timeout hint on empty SUCCESS after print-timeout | 01 |
| 03 | [issues/03-print-timeout-config.md](issues/03-print-timeout-config.md) | First-class antigravity `--print-timeout` option | None |

## Delivery-note placeholders

Fill these on the **feat** side; keep the files on this docs PR as the record.

| Ticket | Placeholder |
| --- | --- |
| 01 | [delivery-notes/01-recognize-tool-checkpoint.md](delivery-notes/01-recognize-tool-checkpoint.md) |
| 02 | [delivery-notes/02-empty-success-timeout-hint.md](delivery-notes/02-empty-success-timeout-hint.md) |
| 03 | [delivery-notes/03-print-timeout-config.md](delivery-notes/03-print-timeout-config.md) |

## Evidence rules

- Cloud / CI: unit tests with committed JSONL fixtures.
- Live `agy` stream-json capture: local evidence only. Do not require agy on PATH for acceptance.
- The Coder's host `10m` print-timeout patch is **not** part of the feat PR.
