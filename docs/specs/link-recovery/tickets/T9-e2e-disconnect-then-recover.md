# T9: E2E round 4: disconnect then recover

**Status:** ready-for-agent

## Goal

Run ONE scenario — disconnect then recover — with disconnection induced 2–3 different ways (WebSocket freeze, Feishu-host blackhole, process sleep/SIGSTOP) plus a kill -9, in card and markdown modes. Not one cell per cause.

## Spec sections

Solution (user-visible contract); Testing Decisions

## Files touched

`e2e/test-bridge/scenarios/` (new disconnect-recover scenario), e2e docs, round-4 report

## Acceptance

- [ ] Failing scenario first against pre-change code (or recorded round-3 failure) for at least one method.
- [ ] For each method × {card, markdown}: a message sent during the outage ends with exactly one reply or one notice and the queue drained.
- [ ] kill -9 mid-run, restart: exactly one reply or notice, queue drained; an ordinary follow-up is answered alone (prior turn 已放弃).
- [ ] No 保活重启 notice in any run.
- [ ] `pnpm ci:local` passes.

## Blocked by

T0, T1, T2, T3, T4, T5, T6, T7, T8
