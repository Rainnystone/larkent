# T6: Continuations state machine (A1)

**Status:** ready-for-agent

## Goal

One per-scope Continuations module: ordinary message → abandoned (card 已放弃, abandon instruction, no continue hint, only new message answered); button or typed 继续 → continue exactly once (card 已继续); stale click → 此继续已失效; `/new` `/cd` `/ws` `/resume` void; persisted across restart.

## Spec sections

§7 Continuations; §9 channel continuation-state row

## Files touched

new `src/bot/continuation.ts`, `src/bot/channel.ts`, `src/bot/dispatcher.ts`, `src/bot/interruption-notice.ts`, turn journal fields, tests

## Acceptance

- [ ] Failing test first: an ordinary message after a notice produces a prompt with the abandon instruction and no continue hint, and the card shows 已放弃.
- [ ] A later button click replies 此继续已失效.
- [ ] Button and typed 继续 each resume exactly once.
- [ ] All of the above holds after a bridge restart.
- [ ] e2e kimi kill -9 repro answers only the new message.
- [ ] `pendingHintByScope`, `continueByScope`, `consecutiveByScope`, `takeContinueRequest`, `rebuildPendingHints`, `rebuildConsecutive` are gone.
- [ ] `pnpm ci:local` passes.

## Blocked by

T0
