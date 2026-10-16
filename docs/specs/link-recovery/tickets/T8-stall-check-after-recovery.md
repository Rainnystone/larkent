# T8: Stall check after recovery

**Status:** ready-for-agent

## Goal

`runs.review(outage)`: any run silent since before `since` gets a 2-minute stall deadline, then stops via the bridge idle-watchdog reason through the normal outcome + notice path.

## Spec sections

§3 step 3; §5 Liveness

## Files touched

`src/bot/recovery.ts`, active runs / run handle, `src/bot/channel.ts`, tests

## Acceptance

- [ ] Failing test first: a run silent since before the outage is stopped within 2 min of recovery with a retriable notice.
- [ ] A run that keeps producing output is left alone.
- [ ] `pnpm ci:local` passes.

## Blocked by

T1, T4
