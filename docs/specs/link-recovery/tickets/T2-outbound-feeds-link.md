# T2: Outbound results feed the link; resend only on recovery

**Status:** ready-for-agent

## Goal

Wrap outbound calls in the link: timeout / no response / 5xx take it down, success is evidence, business 4xx keeps it up. Resend happens only from Recovery. Remove the outbound UUID in-flight guard.

## Spec sections

§2 (down/up evidence); §3; §8 dedupe guards; §9 self-message row

## Files touched

`src/bot/feishu-link.ts`, `src/bot/self-message.ts`, `src/bot/channel.ts`, tests

## Acceptance

- [ ] Failing test first: an `OutboundTimeoutError` takes the link down; a business 4xx keeps it up.
- [ ] A staged reply is resent exactly once after recovery and never while up.
- [ ] `inflightByUuid`, `outboundInFlight`, `attachOutboundUuid`, `stripOutboundUuid` are gone.
- [ ] e2e `proxy slow` passes (one reply, no duplicate).
- [ ] `pnpm ci:local` passes.

## Blocked by

T1
