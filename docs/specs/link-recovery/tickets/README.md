# Link recovery tickets

Spec: [../../link-recovery.md](../../link-recovery.md). One ticket per session; each starts with a failing regression test and ends with `pnpm ci:local` passing.

| Ticket | Title | Blocked by |
|---|---|---|
| [T0](T0-remove-reliability-flags.md) | Remove the six match-master reliability flags | None (can start immediately) |
| [T1](T1-feishu-link-and-recovery.md) | FeishuLink plus a single recovery path | T0 |
| [T2](T2-outbound-feeds-link.md) | Outbound results feed the link; resend only on recovery | T1 |
| [T3](T3-outbox-stages-every-reply.md) | Outbox stages every terminal reply (A2) | T2 |
| [T4](T4-default-idle-bound.md) | Default idle bound for runs (A3) | T0 |
| [T5](T5-retriability-from-shape.md) | Retriability from outcome shape plus outage overlap | T2 |
| [T6](T6-continuations.md) | Continuations state machine (A1) | T0 |
| [T7](T7-transport-only-reconnect.md) | Transport-only reconnect | T1 |
| [T8](T8-stall-check-after-recovery.md) | Stall check after recovery | T1, T4 |
| [T9](T9-e2e-disconnect-then-recover.md) | E2E round 4: disconnect then recover | T0, T1, T2, T3, T4, T5, T6, T7, T8 |

## Blocking graph

```
T0 ──► T1 ──► T2 ──► T3
  │      │      └───► T5
  │      ├──► T7
  │      └──► T8 ◄── T4 ◄── T0
  ├──► T4
  └──► T6
all (T0–T8) ──► T9
```

- T0 blocks all.
- T1 blocks T2, T7, T8. T2 blocks T3, T5. T4 blocks T8.
- All block T9.
- After T0, T1, T4 and T6 can start in parallel.
