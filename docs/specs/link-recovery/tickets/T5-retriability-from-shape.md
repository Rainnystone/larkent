# T5: Retriability from outcome shape plus outage overlap

**Status:** ready-for-agent

## Goal

Add `outageOverlapped` to outcome derivation; `unclassified` becomes retriable and becomes `transient-upstream` when it overlapped an outage; signatures only pick wording and `needsHuman`. Remove `keepalive-restart` stop reason.

## Spec sections

§6 Outcome; §9 run-outcome row

## Files touched

`src/bot/run-outcome.ts`, `src/bot/cli-signatures.ts`, `src/bot/channel.ts`, tests

## Acceptance

- [ ] Failing test first: an unknown stderr failure that overlapped an outage gets a continue notice with network wording.
- [ ] Auth and quota failures still produce needs-human notices as before.
- [ ] No `keepalive-restart` reason remains.
- [ ] `pnpm ci:local` passes.

## Blocked by

T2
