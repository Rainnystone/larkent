# A30 — WS liveness watchdog must not tear down a healthy link

Status: ready-for-agent · Lands on code PR #49 before merge · Blocks A11 retest

## Problem (observed, 2026-10-18)

`src/bot/channel.ts` sets `wsConfig.pingTimeout: 3` (since 0bcb309, 2026-08). The Feishu node SDK (1.73.3) then terminates the WebSocket whenever no inbound frame arrives within 3 s of a client ping. The SDK default is `0` (watchdog off).

On the A11 test bridge (Bot Arena, chat …1372) this fired 31 times in about 4 h, each time logged as `[ws] no pong/inbound within 3s of last ping, terminating to trigger reconnect`. That includes periods when the box was only moderately loaded. Each teardown opens a reconnect window, and any card tap in that window fails in the Feishu client with 「目标回调服务当前未在线」. The user hit this repeatedly while tapping board 删除/恢复 and confirm 是/否. Unlike messages, card callbacks are not backfilled after reconnect, so the tap is simply lost.

Root cause: 3 s is shorter than routine jitter. Event-loop stalls (GC, a busy agent run, a loaded host) and normal network latency can delay the pong, or delay processing it, past 3 s, so a healthy link is classed as dead. The watchdog itself manufactures the outage.

## Required outcome

1. A healthy link under normal jitter (multi-second event-loop stalls, a loaded host) is not torn down. Pick the threshold from first principles: Feishu's server ping interval/config from the SDK, the SDK's reconnect behaviour, and how fast a truly dead link must be detected. Write the reasoning in a code comment. Turning the watchdog off is acceptable only if you show the SDK/channel keepalive still detects a dead link in bounded time.
2. A genuinely dead link (no frames at all) is still detected and reconnected in bounded time. State that bound.
3. No behaviour change for message backfill after reconnect.
4. Keep `log` lines for real teardowns so A11 can count them.

## Tests

- Unit or integration: simulate a pong arriving later than the old 3 s but within the new bound. Assert no teardown.
- Simulate no inbound frames at all. Assert teardown and reconnect within the stated bound.
- Don't weaken existing link-recovery tests. If `feishu-link-recovery.test.ts` depends on the 3 s value, update it to the new contract and keep its timing robust (it already flaked once on a 50 ms wait).

## A11 acceptance (Orchestrator, on the final head)

Over a ≥2 h run on the box with normal background load, real `[ws]` teardowns are ≤ 1 unless the network truly drops, and repeated board/confirm taps never show 「目标回调服务当前未在线」 outside a real outage.

## Out of scope

Any change to the live production bridge config (that's deploy, after merge).
