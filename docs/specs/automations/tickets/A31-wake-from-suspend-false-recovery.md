# A31 — Wake from suspend must reconnect, not report a false recovery

Status: ready-for-agent · Blocked by: none · Track: code PR #49, branch `feat/automations-v2` (refs verified at b020c23) · Lands before merge · Scope: follows A30 · One ticket per session

## Problem (observed, A11 retest 2026-10-19)

The host froze for about 577 s (02:02:06 → 02:11:43 UTC+8). On wake the bridge logged:

1. `tick-gap` with `gapMs` 577701
2. `channel: keepalive wake-up`
3. `link recovered` with `hostSuspended:false`, about 2 s after wake

The socket was already dead at that point. The bridge only noticed at 02:12:50 via `[ws] no pong/inbound within 15s of last ping, terminating to trigger reconnect`, and reconnected at 02:13:08. That left the link dead for about 85 s after wake, and Feishu showed 「回调未在线」 for card taps in that window.

## Cause (refs at b020c23)

- `src/bot/channel.ts:206-236`: the SDK (node-sdk 1.73.3) liveness watchdog only arms when the client sends a ping, on the server cadence (`WS_SERVER_PING_INTERVAL_SEC = 120`, `WS_PING_TIMEOUT_SEC = 15`, line 222). So the worst case after wake is `WS_DEFAULT_DEAD_LINK_DETECT_BOUND_SEC` = 135 s.
- `@larksuite/channel` 0.7.1 `dist/index.cjs:432-437`: the keepalive `tick` sees `sinceLast > SLEEP_DETECT_MS`, logs `channel: keepalive wake-up`, resets its counters and returns. It never reconnects. (The repo patches this package in `patches/@larksuite__channel@0.7.1.patch`, so check whether the patch touches this path.)
- `src/bot/feishu-link.ts:237-260` (`noteSuspendIfGap`, called from the tick at :286 and after a probe at :324): it handles the gap by going down and starting sleep detection. Then the next probe or status check sees `getConnectionStatus()` still `connected` (stale) and marks the link recovered. Nothing on the new socket has been seen yet.

## Required outcome

1. When a tick gap or keepalive wake-up is detected, force an immediate reconnect of the WS. Don't wait for the next ping cycle.
2. Don't mark the link `recovered` until an inbound frame or pong arrives on the **new** socket. Stale `connected` status or a probe from before the reconnect doesn't count.
3. Make the smallest change that does this. Don't bump any timeout (`WS_PING_TIMEOUT_SEC`, ping interval, sleep thresholds). A30's contract stays as it is.
4. Keep the log lines (`tick-gap`, `keepalive wake-up`, `recovered`) so A11 can count them. Add one line for the forced reconnect.

## Tests (fake timers)

- Simulate a suspend gap of several minutes, with no timer ticks and the socket silently dead. Assert a reconnect is triggered within seconds of the first tick after wake.
- Assert there is no `recovered` before an inbound frame or pong on the new socket. After the frame is delivered, assert `recovered`.
- Assert a normal tick with no gap triggers no reconnect.
- Don't weaken the existing `feishu-link-recovery` tests.

## A11 acceptance

After a real host suspend of 60 s or more, the bridge reconnects within a few seconds of wake. `recovered` is logged only after the reconnect, and card taps after wake don't show 「回调未在线」 beyond that short window.

## Out of scope

Changes to the live production bridge (that's deploy, after merge), and timeout tuning.
