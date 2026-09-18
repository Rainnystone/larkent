# Dual-track: agy envelope scrub v2

Docs track for the Antigravity final_text envelope **classifier** (supersedes #30 unclosed / nesting policy) and envelope family #2 (`<task_notification>`).

Grill closed (Fable + private-chat verification 2026-09-18). Spec: [docs/specs/agy-envelope-scrub-v2.md](../../docs/specs/agy-envelope-scrub-v2.md).

Tickets below are tracer-bullet slices of that Spec. They are not product code.

## Tracks

| Track | Branch | PR | What it may contain |
| --- | --- | --- | --- |
| Docs (this) | `docs/agy-envelope-scrub-v2` | **[TBD](https://github.com/Rainnystone/larkent/pull/TBD)** (draft) | Spec, tickets, this README, delivery-note placeholders |
| Code | `feat/agy-envelope-scrub-v2` | **[TBD](https://github.com/Rainnystone/larkent/pull/TBD)** (draft) | Product code + tests only (opened empty) |

Do **not** merge this docs PR to `master` as a substitute for the feat PR. Do **not** open a feature/code PR from this branch. Do **not** copy `.scratch/` scaffolding, Spec files, or delivery-note templates onto the feat branch.

## How an implementer claims a ticket

1. Read the Spec. Then read **one** ticket whose blockers are all done.
2. Claim it **on the docs PR** (edit Status / delivery-note placeholder, or comment). Read-only claim: recording who is working it, not implementing here.
3. Branch work from the **code** PR branch (`feat/agy-envelope-scrub-v2`), not from this docs branch.
4. `/implement` + in-session `/code-review` for that ticket only. Push only to the code PR.
5. Fill the matching delivery-note placeholder; leave the docs PR as the ticket board.

Work the frontier: any ticket whose `Blocked by` is empty or already delivered. **Do not jump to implement until claiming.**

## Tickets

| # | Path | Title | Blocked by |
| --- | --- | --- | --- |
| 01 | [issues/01-envelope-classifier-scrub.md](issues/01-envelope-classifier-scrub.md) | SYSTEM_MESSAGE envelope classifier scrub (supersede #30) | None |
| 02 | [issues/02-task-notification-envelope.md](issues/02-task-notification-envelope.md) | Scrub `<task_notification>` envelope family #2 | 01 |

## Delivery-note placeholders

Fill these on the **feat** side; keep the files on this docs PR as the record.

| Ticket | Placeholder |
| --- | --- |
| 01 | [delivery-notes/01-envelope-classifier-scrub.md](delivery-notes/01-envelope-classifier-scrub.md) |
| 02 | [delivery-notes/02-task-notification-envelope.md](delivery-notes/02-task-notification-envelope.md) |

## Evidence rules

- Cloud / CI: unit tests with committed fixtures at the pure envelopes module and translator seams.
- Live Feishu / agy capture: local evidence only. Do not require agy on PATH for acceptance.
- Feishu message-edit lengths may diverge from bridge outbound — diagnose from logs + conversation DB.
- No product code on this docs PR. No Cloud Agent implement from this scaffolding turn.
