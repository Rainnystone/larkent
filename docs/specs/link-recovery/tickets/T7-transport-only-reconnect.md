# T7: Transport-only reconnect

**Status:** ready-for-agent

## Goal

Enable SDK keepalive for WebSocket reconnect; the bridge never calls `controls.restart` for link problems; unrecoverable only logs.

## Spec sections

§2 (no reconnect authority); §9 keepalive wiring row; §10 Same PR

## Files touched

`src/bot/channel.ts`, `src/bot/feishu-link.ts`, `src/bot/supervisor.ts`, tests

## Acceptance

- [ ] Failing test first: a WebSocket stuck for 60 s with a healthy probe never calls `controls.restart`, and the active run still replies once.
- [ ] e2e `proxy disconnect` mid-run produces no 保活重启 notice.
- [ ] `pnpm ci:local` passes.

## Blocked by

T1
