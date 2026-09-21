# Dual-track: p2p / DM wake-up backfill

Docs track extending in-bridge wake-up backfill to **session-known p2p chats** (v1 Spec §19 follow-on).

Grill skipped 2026-09-21 (operator-locked). Spec: [docs/specs/p2p-wake-up-backfill.md](../../docs/specs/p2p-wake-up-backfill.md).

Tickets below are tracer-bullet slices. They are not product code. Implementers **read-only claim** from this docs draft PR and push commits only to the clean code feat PR branched from `master`.

## Blocking graph

```
01-p2p-backfill-tracer
        │
        ▼
02-hardening-parity-docs
```

Parallel start set: **01** only.

## Tickets

| # | File | Blocked by | Delivers |
|---|------|------------|----------|
| 01 | [issues/01-p2p-backfill-tracer.md](issues/01-p2p-backfill-tracer.md) | — | Session-known p2p scan + real chat_type + no-@ filter → intake |
| 02 | [issues/02-hardening-parity-docs.md](issues/02-hardening-parity-docs.md) | 01 | Parity/regression tests, CONTEXT/ops notes, negative discovery |

## Delivery notes

Fill `delivery-notes/NN-….md` (or a PR comment on this docs PR) after each ticket lands on the code PR: ticket id, code SHA/PR link, pass/fail, leftover risk.
