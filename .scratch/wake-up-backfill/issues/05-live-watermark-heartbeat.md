# 05: Live watermark heartbeat + `/doctor` self-heal line

**What to build:** The processed ledger learns when the bot was last *really* listening. On every keepalive tick that observes the WS in `connected` state, the bridge advances the **live watermark** (`lastLiveAt`) in the ledger, with writes throttled to at least 30 s apart. During a WS blip the process is alive but the watermark stops; during a host freeze no tick fires at all, so both look the same to a later reader — that is the property backfill (ticket 07) relies on. `/doctor` gains one line: ledger path, watermark age, processed-id count, and (once 07 lands) the last backfill summary. Demoable alone: run a profile, watch `lastLiveAt` advance in the file, pull the network, watch it stop, restore, watch it resume.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Keepalive gets an optional dependency that is invoked with `now` only on ticks where `getConnectionStatus().state === 'connected'`; it is **not** invoked on the wake-up / storm-guard early returns or while `ws-stuck`.
- [ ] Ledger exposes `touchLive(now)` that updates `lastLiveAt` in memory and persists at most once per 30 s (throttle inside the ledger, not in keepalive), plus a getter for the current watermark and `lastBackfillEnd`.
- [ ] Clock going backwards (`now < lastLiveAt`) is tolerated: watermark rewritten to `now`, warn `backfill.clock-skew` once.
- [ ] `/doctor` prints a "self-heal" line: ledger path, `lastLiveAt` age in human units (or "not yet recorded"), processed count; wording is profile-generic and does not mention any agent kind.
- [ ] Tests: fake clock + fake channel status — connected ticks advance the watermark at most every 30 s; disconnected/stuck ticks do not; no write when the value did not change; `/doctor` renders the line from ledger state.
- [ ] No new timers: the heartbeat rides the existing 15 s keepalive interval.
