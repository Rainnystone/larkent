# Dual-track: cursor assistant CoT hold-back

Docs track for aligning `CursorJsonlTranslator` with Grok-style hold-back so Opus 5.5 High pre-tool English plan monologues no longer stream to Feishu as `text`.

Grill closed (product decisions locked 2026-09-23). Spec: [docs/specs/cursor-assistant-cot-holdback.md](../../docs/specs/cursor-assistant-cot-holdback.md).

Tickets below are tracer-bullet slices of that Spec. They are not product code.

## Tracks

| Track | Branch | PR | What it may contain |
| --- | --- | --- | --- |
| Docs (this) | `docs/cursor-assistant-cot-holdback` | **[#35](https://github.com/Rainnystone/larkent/pull/35)** (draft) | Spec, tickets, this README, delivery-note placeholders |
| Code | `feat/cursor-assistant-cot-holdback` | **[#36](https://github.com/Rainnystone/larkent/pull/36)** (draft) | Product code + tests only (opened empty) |

Do **not** merge this docs PR to `master` as a substitute for the feat PR. Do **not** open a feature/code PR from this branch. Do **not** copy `.scratch/` scaffolding, Spec files, or delivery-note templates onto the feat branch.

## How an implementer claims a ticket

1. Read the Spec. Then read **one** ticket whose blockers are all done.
2. Claim it **on docs PR [#35](https://github.com/Rainnystone/larkent/pull/35)** (edit Status / delivery-note placeholder, or comment). Read-only claim: recording who is working it, not implementing here.
3. Branch work from the **code** PR branch (`feat/cursor-assistant-cot-holdback` / [#36](https://github.com/Rainnystone/larkent/pull/36)), not from this docs branch.
4. `/implement` + in-session `/code-review` for that ticket only. Push only to the code PR.
5. Fill the matching delivery-note placeholder; leave the docs PR as the ticket board.

Work the frontier: any ticket whose `Blocked by` is empty or already delivered. **Do not jump to implement until claiming.** Main flow: Spec → `/to-tickets` (this board) → later `/implement`.

## Tickets

| # | Path | Title | Blocked by |
| --- | --- | --- | --- |
| 01 | [issues/01-cursor-holdback-tracer.md](issues/01-cursor-holdback-tracer.md) | Cursor hold-back tracer (`CursorJsonlTranslator` + unit tests) | None |

## Delivery-note placeholders

Fill these on the **feat** side; keep the files on this docs PR as the record.

| Ticket | Placeholder |
| --- | --- |
| 01 | [delivery-notes/01-cursor-holdback-tracer.md](delivery-notes/01-cursor-holdback-tracer.md) |

## Evidence rules

- Cloud / CI: unit tests in `tests/unit/agent/cursor-jsonl.test.ts` (+ translator changes under `src/agent/cursor/`).
- Live Feishu / Opus capture: local evidence only; not required for ticket acceptance if fixtures cover the leak shape.
- No product code on this docs PR. No Cloud Agent implement from this scaffolding turn.
- Forbidden “fixes”: `thinking:false`, lowering effort, editing `~/.cursor/cli-config.json`, English CoT regex.
