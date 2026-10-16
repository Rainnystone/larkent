# Automations tickets

Spec: [../../automations.md](../../automations.md). One ticket per session; each starts with a failing test that asserts what the chat receives and ends with `pnpm ci:local` passing. No latency criteria.

| Ticket | Title | Blocked by |
|---|---|---|
| [A1](A1-tracer-one-shot-reminder.md) | Tracer: one-shot reminder end to end | link-recovery merged |
| [A2](A2-recurring-schedule-grammar.md) | Recurring schedules, floors, end required | A1 |
| [A3](A3-missed-and-restart-idempotency.md) | Missed fires and restart idempotency | A1 |
| [A4](A4-board-card.md) | Pinned board with Pause/Delete for anyone | A1 |
| [A5](A5-monitor-hook.md) | Monitor hook and local status file | A3, A4 |
| [A6](A6-natural-language-creation.md) | Natural-language creation | A2 |
| [A7](A7-lifecycle-and-observability.md) | Bot removed, p2p, observability | A4 |
| [A8](A8-agent-kind-run.md) | Agent kind: fresh-session run and result post | A2, A3 |
| [A9](A9-agent-safety-whitelist.md) | Agent safety: bot-only identity, whitelist | A8 |
| [A10](A10-backfill-skip-non-chat-scopes.md) | Backfill skips auto:/meeting: scopes (F20) | None |
| [A11](A11-e2e-bot-arena.md) | E2E in Bot Arena (controller) | A1–A10 |

## Blocking graph

```
(link-recovery) ─► A1 ─┬─► A2 ─┬─► A6
                       │       └─► A8 ─► A9
                       ├─► A3 ─┬─► A8
                       │       └─► A5
                       └─► A4 ─┬─► A5
                               └─► A7
A10 (independent)
all ─► A11
```

Reminder ships after A1–A5 (+A7); agent kind after A8–A9.
