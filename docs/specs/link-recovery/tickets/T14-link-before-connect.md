# T14: Link and outbound wrapper exist before connect

**Status:** ready-for-agent · Audit: D6 (F16)

## Goal

Create FeishuLink and the outbound wrapper before `channel.connect()`, so no message is handled with unwrapped outbound calls or the always-up stub link. Runs get the link through a getter, not a captured stub. `ownerRefresh.start` (network) must no longer delay link creation.

## Spec sections

§2 FeishuLink; Delivery invariants (I2)

## Acceptance (behaviour, failing first)

- [ ] A message handled during startup (between connect and the old `startFeishuLink` point) has its reply id recorded, and its echo is not treated as a CLI self-send (the final reply is not skipped).
- [ ] A run that starts during startup and overlaps a later outage reports `outageOverlapped=true`.
- [ ] Startup and supervisor swap still recover exactly once (the link starts down from the watermark).
- [ ] `pnpm ci:local` passes.

## Files likely touched

`src/bot/channel.ts` (startup order, stub link ~605–611, run link capture), `src/bot/feishu-link.ts`, `src/bot/self-message.ts`, startup tests

## Delete

The stub link that always reports up with epoch 0.

## Blocked by

T13 (touches the same delivery wiring; can be done right after T11 if T12/T13 stall)
