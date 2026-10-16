# T15: Recovery hardening, simpler probe, channel cleanups

**Status:** ready-for-agent · Audit: D7 part 1 + §5 probe and `channel.ts` items (F19, F22)

## Goal

- Each recovery step (reap orphans, redeliver, backfill, review) runs in its own try/catch. If any step fails, the outage window is re-queued for the next recovery (I9).
- Simpler probe:
  - Every tick runs gap detection and updates `lastTickAt`, even while a probe is in flight.
  - A detected gap bumps `probeSeq`, and any late probe result with an old seq is discarded.
  - Keep `raceProbe` with its timeout.
- Cleanups in `channel.ts` (behaviour unchanged).
- This is the last ticket that changes behaviour, so it also rewrites the outbox description in `CONTEXT.md` (~line 56). The new text describes: staged items with per-item state and receipts; the stream result as the delivery signal; the single classifier; no sends while down. Remove the remainder, 4xx/local-fallback and ECONNABORTED claims.

**Run review is unchanged** (spec §5): any run silent since before `since` still gets the 2-minute deadline.
- **Open product question for index li:** should run review apply only to real outages, i.e. skip runs with an open tool call unless the host actually suspended? The audit (D7 part 2, F21) recommends it.
- Not implemented here unless decided. If adopted, add the test "a 20 s network outage does not stop a run inside a 10-minute tool call."

## Spec sections

§3 Recovery; §2 FeishuLink (probe); §5 Liveness (unchanged); Delivery invariants (I9)

## Acceptance (behaviour, failing first)

- [ ] Backfill throws → run review still runs, and the window is retried at the next recovery (messages from the window answered once).
- [ ] Journal flush throws during redeliver → backfill and review still run, and staged items go out at the next recovery.
- [ ] A host suspend during an in-flight probe → the gap is detected on the next tick, the late probe result is ignored, and recovery happens exactly once.
- [ ] `CONTEXT.md` outbox section matches the implemented behaviour.
- [ ] `pnpm ci:local` passes.

## Files likely touched

`src/bot/recovery.ts`, `src/bot/feishu-link.ts`, `src/bot/channel.ts`, `src/bot/interruption-notice.ts`, `CONTEXT.md`, recovery/link tests

## Delete

- Probe: `noteSleepIfProbeSuspended`, `probeWallStart`, `probeMonoStart`, the `monotonic` dependency (only logged as `monoElapsed`), and the `probing` early return in `tick`.
- `channel.ts`:
  - the second `cliSelfSent.consume` (~2218; the `finally` already does it)
  - the duplicated skip predicate in `sendFinalReply` (~2273–2283)
  - the no-op `fallback` parameter and `runFallbackReply`
  - the `noticeEnabled` branches (always true)

## Blocked by

T14
