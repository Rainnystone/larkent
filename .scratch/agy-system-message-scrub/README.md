# Dual-track: agy `<SYSTEM_MESSAGE>` scrub

Docs track for stripping Antigravity `<SYSTEM_MESSAGE>` envelopes from Feishu final replies.

Grill skipped (diagnosis locked 2026-09-18). Spec: [docs/specs/agy-system-message-scrub.md](../../docs/specs/agy-system-message-scrub.md).

## Tracks

| Track | Branch | PR | What it may contain |
| --- | --- | --- | --- |
| Docs (this) | `docs/agy-system-message-scrub` | **[#29](https://github.com/Rainnystone/larkent/pull/29)** | Spec, tickets, this README, delivery-note placeholders |
| Code | `feat/agy-system-message-scrub` | **[#30](https://github.com/Rainnystone/larkent/pull/30)** | Product code + tests only |

Do **not** merge this docs PR to `master` as a substitute for the feat PR. Do **not** open a feature PR from this branch. Do **not** copy `.scratch/` onto the feat branch.

## How an implementer claims a ticket

1. Read the Spec. Then read **one** ticket whose blockers are done.
2. Claim on docs PR [#29](https://github.com/Rainnystone/larkent/pull/29) (status / comment). Read-only claim.
3. Branch work from the **code** PR branch (`feat/agy-system-message-scrub`), not from this docs branch.
4. `/implement` + in-session `/code-review` for that ticket only. Push only to the code PR.
5. Fill the delivery-note placeholder; leave docs PR as the board.

## Tickets

| # | Path | Title | Blocked by |
| --- | --- | --- | --- |
| 01 | [issues/01-scrub-system-message-final-text.md](issues/01-scrub-system-message-final-text.md) | Scrub `<SYSTEM_MESSAGE>` from Antigravity `final_text` | None |
