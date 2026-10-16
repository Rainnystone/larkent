# T3: Outbox stages every terminal reply (A2)

**Status:** ready-for-agent

## Goal

Narrow the journal to the Outbox interface; stage before the first attempt in every reply mode including streamed; the final render reports failure; a failed final patch stays staged and is redelivered as a fresh reply quoting the trigger. Remove journal delivery lock and live-notice set.

## Spec sections

§4 Outbox; §8 dedupe guards; §9 turn-journal, interruption-notice, `alreadyStreamed` rows

## Files touched

`src/bot/turn-journal.ts`, `src/bot/interruption-notice.ts`, `src/bot/channel.ts` (stream/card/markdown final render), tests

## Acceptance

- [ ] Failing test first: in markdown and in card mode, a rejected final patch leaves the terminal text staged.
- [ ] Recovery delivers exactly one reply; a second recovery sends nothing.
- [ ] Public `update`, `withDelivery`, `isDelivering`, `deliveries`, `noteDelivery`, `liveNoticeSends`, `stageOnly` are gone.
- [ ] e2e `proxy eai_again` mid-run then `off` delivers the reply or notice.
- [ ] `pnpm ci:local` passes.

## Blocked by

T2
