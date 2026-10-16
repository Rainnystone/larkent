# T4: Default idle bound for runs (A3)

**Status:** ready-for-agent

## Goal

`runIdleTimeoutMinutes` defaults to 15 (0 disables); an open tool call pauses the watchdog for at most 60 min; run handles expose `lastEventAt`.

## Spec sections

§5 Liveness

## Files touched

`src/config/schema.ts`, `src/bot/channel.ts` (watchdog), run handle / active runs, `/timeout` command, tests

## Acceptance

- [ ] Failing test first: with the setting unset, 15 min of silence ends the run as `idle_timeout` and the queued message runs next.
- [ ] An open tool call is stopped at 60 min.
- [ ] `/timeout 0` disables the watchdog.
- [ ] e2e blackhole of the model host ends the run within 15 min and drains the queue.
- [ ] `pnpm ci:local` passes.

## Blocked by

T0
