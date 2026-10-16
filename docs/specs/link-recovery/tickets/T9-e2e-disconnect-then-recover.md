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
- [ ] A streamed run longer than 30 s on a healthy network causes no outage (no recovery logged, no run stopped).
- [ ] Markdown and card: an outage that hits only the final stream update still ends with one full answer.
- [ ] `pnpm ci:local` passes.

## Blocked by

T0–T8, T11, T12, T13, T14, T15 (T16 optional, not required)

## Latency check (normal network)

- In Bot Arena on the isolated test bridge, with the network healthy, measure time from the tester's message to the bot's first visible reply and to the final reply, in card and markdown modes (≥5 samples each).
- Compare against the E2E round-3 baseline. Accept if there is no user-noticeable regression; record the numbers in the E2E report.
- Reply-before-send journaling is local disk only (no model tokens); this check confirms it in real use rather than via a unit-test threshold.
