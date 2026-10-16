# T0: Remove the six match-master reliability flags

**Status:** ready-for-agent

## Goal

Delete `lostMessage`, `shortGapScan`, `runOutcome`, `cliSignatures`, `journal`, `journalRecover`, keeping today's default behaviour as the only path. Prefactor so every later ticket edits a single branch.

## Spec sections

§8 No tech debt; §9 Deletion table (Config row); §10 Same PR

## Files touched

`src/config/schema.ts`, config load/save + UI preferences parser, `src/bot/channel.ts` (`streamReliability`), `src/bot/backfill.ts`, `src/bot/turn-journal.ts`, `src/bot/interruption-notice.ts`, `src/bot/run-outcome.ts`, `src/bot/cli-signatures.ts`, affected tests

## Acceptance

- [ ] Failing test first: loading a profile containing the six old keys yields a config without them and saving does not write them back.
- [ ] `rg` finds no reference to the six flags in `src/`.
- [ ] Existing behaviour tests for default settings pass unchanged (defaults preserved).
- [ ] `pnpm ci:local` passes.

## Blocked by

None (can start immediately)
