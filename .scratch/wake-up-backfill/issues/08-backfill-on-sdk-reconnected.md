# 08: Backfill on SDK `reconnected` — blips, coalescing, and storm protection

**What to build:** Short WS outages that the Channel SDK repairs on its own (no bridge rebuild) also self-heal. The SDK's `reconnected` event becomes the second **recovery signal** and invokes the same backfill routine as ticket 07 with `trigger: 'reconnected'`. A per-profile mutex makes overlapping triggers coalesce onto the in-flight scan (`backfill.coalesced`) and a trigger after completion starts a fresh scan from the updated watermark. Combined with the `minGapMs` skip, a flapping network produces at most one scan per real gap and no API storms. Late WS deliveries of messages the scan already handed off (possible only for outages under the SDK's 30 min stale window) lose the claim and log `intake.skip-duplicate`. Demoable by simulating `reconnecting` → `reconnected` with a fake channel and a ≥ 60 s watermark gap.

**Blocked by:** 07

**Status:** done

- [x] `channel.on({ reconnected })` calls the shared backfill routine after its existing logging; the routine is the only place that decides to skip or scan.
- [x] Mutex: a second trigger during a scan returns the same promise and logs `backfill.coalesced`; after completion a new trigger runs a new scan; the mutex is per bridge instance (a new bridge from `controls.restart()` has its own, and the shared ledger keeps them consistent).
- [x] Ten `reconnected` events within a minute after one real 5 min gap → exactly one scan, nine `coalesced` or `skip-short-gap` lines, no extra `listChats` calls.
- [x] Late-WS race test (B2, reconnected variant): backfill hands id X to intake, then the live event for X arrives → one run, one `intake.skip-duplicate` with `source: 'ws'`; and the mirror order with `source: 'backfill'`.
- [x] `backfill.trigger` carries `trigger: 'connect' | 'reconnected'`, `gapMs`, `windowStart`, `windowEnd`.
- [x] Still no timer-based trigger anywhere; the keepalive `wake-up` line remains a log, not a trigger.
