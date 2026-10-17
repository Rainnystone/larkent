# T15: Recovery hardening, simpler probe, channel cleanups

**Status:** ready-for-agent · Audit: D7 (both parts) + §5 probe and `channel.ts` items (F19, F21, F22)

## Goal

- Each recovery step (reap orphans, redeliver, backfill, review) runs in its own try/catch. If any step fails, the outage window is re-queued for the next recovery (I9).
- Simpler probe:
  - Every tick runs gap detection and updates `lastTickAt`, even while a probe is in flight.
  - A detected gap bumps `probeSeq`, and any late probe result with an old seq is discarded.
  - Keep `raceProbe` with its timeout.
- Cleanups in `channel.ts` (behaviour unchanged).
- This is the last ticket that changes behaviour, so it also rewrites the outbox description in `CONTEXT.md` (~line 56). The new text describes: staged items with per-item state and receipts; the stream result as the delivery signal; the single classifier; no sends while down. Remove the remainder, 4xx/local-fallback and ECONNABORTED claims.

**Run review only stops tool-call runs after a real host suspend** (D7 part 2, user decision 2026-10-17; fixes F21):
- FeishuLink sets `Outage.hostSuspended = true` only when real OS sleep evidence falls inside the gap (spec §5: Linux boottime minus monotonic, macOS `kern.waketime`/`kern.sleeptime`, Windows System event log power transition). A tick gap over 30 s only triggers that check. Each check has its own timeout; failure or no evidence means not suspended. An outage from link evidence alone (WebSocket down, probe failed or timed out, outbound link error) has `hostSuspended = false`.
- `runs.review(outage)`: a silent run with an open tool call gets the 2-minute deadline only when `outage.hostSuspended`. Otherwise it is left alone (the idle watchdog and the 60-minute tool-call cap still bound it). Silent runs without an open tool call are reviewed as before.

## Spec sections

§3 Recovery; §2 FeishuLink (probe); §5 Liveness (run review and host suspend); Delivery invariants (I9)

## Acceptance (behaviour, failing first)

- [ ] Backfill throws → run review still runs, and the window is retried at the next recovery (messages from the window answered once).
- [ ] Journal flush throws during redeliver → backfill and review still run, and staged items go out at the next recovery.
- [ ] A host suspend during an in-flight probe → the gap is detected on the next tick, the late probe result is ignored, and recovery happens exactly once.
- [ ] A 20 s network outage (WebSocket/probe down, no tick gap) does not stop or deadline a run inside a 10-minute tool call; the run finishes and its answer is delivered once.
- [ ] A host suspend during an outage (tick gap > 30 s **and** OS sleep evidence) still applies the 2-minute review deadline to a silent run with an open tool call, which ends through the normal outcome + notice path.
- [ ] A suspend during an in-flight probe with OS sleep evidence yields `hostSuspended = true`; an outage from a failed probe alone yields `false` (FeishuLink unit test with a fake clock and a fake sleep-evidence source).
- [ ] A tick gap with no sleep evidence (SIGSTOP, event-loop stall, debugger pause, clock jump) yields `hostSuspended = false`, and a run inside a tool call is not stopped.
- [ ] The sleep-evidence check failing or timing out yields `hostSuspended = false`; the run is not stopped.
- [ ] A silent run with no open tool call is still reviewed after a network-only outage (unchanged).
- [ ] `CONTEXT.md` outbox section matches the implemented behaviour.
- [ ] `pnpm ci:local` passes.

**Optional manual check** (not part of acceptance, not a merge gate; the guard is a precaution and the likely deployment is an always-on Mac mini): on a Mac, close the lid for at least 2 minutes with a run inside a tool call, then open it. The outage should be marked `hostSuspended = true` from `kern.waketime`. A SIGSTOP of the same length should mark it `false`.

## Files likely touched

`src/bot/recovery.ts`, run review / liveness watchdog, `src/bot/feishu-link.ts`, `src/bot/channel.ts`, `src/bot/interruption-notice.ts`, `CONTEXT.md`, recovery/link tests

## Delete

- Probe: `noteSleepIfProbeSuspended`, `probeWallStart`, `probeMonoStart`, the `monotonic` dependency (only logged as `monoElapsed`), and the `probing` early return in `tick`.
- `channel.ts`:
  - the second `cliSelfSent.consume` (~2218; the `finally` already does it)
  - the duplicated skip predicate in `sendFinalReply` (~2273–2283)
  - the no-op `fallback` parameter and `runFallbackReply`
  - the `noticeEnabled` branches (always true)

## Blocked by

T14
