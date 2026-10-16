# Link recovery tickets

Spec: [../../link-recovery.md](../../link-recovery.md) (see *Delivery invariants*). T11–T16 come from the 2026-10-16 failure-mode audit of the code branch. One ticket per session; each starts with a failing regression test and ends with `pnpm ci:local` passing.

| Ticket | Title | Blocked by | Status |
|---|---|---|---|
| [T0](T0-remove-reliability-flags.md) | Remove the six match-master reliability flags | None (can start immediately) | done (code track) |
| [T1](T1-feishu-link-and-recovery.md) | FeishuLink plus a single recovery path | T0 | done (code track) |
| [T2](T2-outbound-feeds-link.md) | Outbound results feed the link; resend only on recovery | T1 | done (code track) |
| [T3](T3-outbox-stages-every-reply.md) | Outbox stages every terminal reply (A2) | T2 | done (code track) |
| [T4](T4-default-idle-bound.md) | Default idle bound for runs (A3) | T0 | done (code track) |
| [T5](T5-retriability-from-shape.md) | Retriability from outcome shape plus outage overlap | T2 | done (code track) |
| [T6](T6-continuations.md) | Continuations state machine (A1) | T0 | done (code track) |
| [T7](T7-transport-only-reconnect.md) | Transport-only reconnect | T1 | done (code track) |
| [T8](T8-stall-check-after-recovery.md) | Stall check after recovery | T1, T4 | done (code track) |
| [T10](T10-review-followups.md) | Review follow-ups (fix alongside code review) | T0–T8 | done |
| [T11](T11-one-classifier-stream-untimed.md) | One error classifier; stream outside the outbound timeout | T10 | ready |
| [T16](T16-feishu-uuid-idempotency.md) | Exactly-once delivery: Feishu uuid, same-card recovery, read-back | T11 | ready |
| [T12](T12-stream-result-is-delivery-signal.md) | Stream result is the only delivery signal; same-card recovery | T16 | ready |
| [T13](T13-per-item-outbox-and-gating.md) | Per-item reply/notice state; no sends while down | T12 | ready |
| [T14](T14-link-before-connect.md) | Link and outbound wrapper before connect | T13 | ready |
| [T15](T15-recovery-hardening-probe-cleanup.md) | Recovery hardening, suspend-only tool-call review, simpler probe, channel cleanups, CONTEXT.md | T14 | ready |
| [T9](T9-e2e-disconnect-then-recover.md) | E2E round 4: disconnect then recover | T0–T8, T11–T16 | blocked (last) |

## Blocking graph

```
T0 ──► T1 ──► T2 ──► T3
  │      │      └───► T5
  │      ├──► T7
  │      └──► T8 ◄── T4 ◄── T0
  ├──► T4
  └──► T6
T10 ──► T11 ──► T16 ──► T12 ──► T13 ──► T14 ──► T15
all (T0–T8, T11–T16) ──► T9
```

- T0 blocks all.
- T1 blocks T2, T7, T8. T2 blocks T3, T5. T4 blocks T8.
- Strict sequence: T11 → T16 → T12 → T13 → T14 → T15. T16 is mandatory (exactly-once, I1, user decision 2026-10-17); it comes before T12/T13 because both build on its uuid sender, same-card patch and read-back.
- T0–T8 and T11–T16 block T9; T9 runs last.
- After T0, T1, T4 and T6 can start in parallel.
