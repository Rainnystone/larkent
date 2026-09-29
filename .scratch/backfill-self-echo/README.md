# Dual-track: backfill self-echo

Docs track for stopping wake-up / connect / reconnected backfill from re-answering the bot's own replies (p2p self-echo chain after PR #34), plus isolating persistent per-chat 4xx failures so they stop pinning the backfill window open.

Grill closed (product decisions locked 2026-09-29). Spec: [docs/specs/backfill-self-echo.md](../../docs/specs/backfill-self-echo.md).

Tickets below are tracer-bullet slices of that Spec. They are not product code.

## Tracks

| Track | Branch | PR | What it may contain |
| --- | --- | --- | --- |
| Docs (this) | `docs/backfill-self-echo` | **DOCS_PR** (draft) | Spec, tickets, this README, delivery-note placeholders |
| Code | `feat/backfill-self-echo` | **CODE_PR** (draft) | Product code + tests only (opened empty) |

Do **not** merge this docs PR to `master` as a substitute for the feat PR. Do **not** open a feature/code PR from this branch. Do **not** copy `.scratch/` scaffolding, Spec files, or delivery-note templates onto the feat branch.

## Blocking graph

```
01-self-echo-tracer
        │
        ▼
02-persistent-chat-failure-isolation
```

Parallel start set: **01** only (02 touches the same file, `src/bot/backfill.ts`).

## How an implementer claims a ticket

1. Read the Spec. Then read **one** ticket whose blockers are all done.
2. Claim it **on docs PR DOCS_PR** (edit Status / delivery-note placeholder, or comment). Read-only claim: recording who is working it, not implementing here.
3. Branch work from the **code** PR branch (`feat/backfill-self-echo` / CODE_PR), not from this docs branch.
4. `/implement` (embeds `/tdd`) + in-session `/code-review` for that ticket only. Push only to the code PR.
5. Fill the matching delivery-note placeholder; leave the docs PR as the ticket board.

Work the frontier: any ticket whose `Blocked by` is empty or already delivered. **Do not jump to implement until claiming.**

## Tickets

| # | Path | Title | Blocked by |
| --- | --- | --- | --- |
| 01 | [issues/01-self-echo-tracer.md](issues/01-self-echo-tracer.md) | Self-echo tracer (app-id self + p2p app skip + echo-chain regression) | None |
| 02 | [issues/02-persistent-chat-failure-isolation.md](issues/02-persistent-chat-failure-isolation.md) | Persistent per-chat failure isolation | 01 |

## Delivery-note placeholders

Fill these on the **feat** side; keep the files on this docs PR as the record.

| Ticket | Placeholder |
| --- | --- |
| 01 | [delivery-notes/01-self-echo-tracer.md](delivery-notes/01-self-echo-tracer.md) |
| 02 | [delivery-notes/02-persistent-chat-failure-isolation.md](delivery-notes/02-persistent-chat-failure-isolation.md) |

## Evidence rules

- Cloud / CI: unit tests in `tests/unit/bot/backfill.test.ts` (+ changes under `src/bot/backfill.ts` and the one wiring line in `src/bot/channel.ts`).
- Live Feishu / bridge-log capture (`~/.lark-channel/profiles/<p>/logs/bridge-YYYYMMDD.jsonl`): local evidence only; not required for ticket acceptance if fixtures cover the shapes.
- No product code on this docs PR.
- Forbidden "fixes": outbound-id ledger, config flag, disabling backfill, broadening group filtering, bridge/supervise/keepalive edits.
