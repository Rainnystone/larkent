# D07 Draft confirmation module

Spec: A8, D3, D4. Blocked by: D02, D06.
Touch: `src/automations/command.ts` (~816-905 `draftCardClaims` / `flushDraftCardOnce` / `deliverUnboundDraftCard`; ~1216-1467 `postEndCard` / `postConfirmCard` / `postDeleteCard` and settle failures; ~992-1125 `confirmAutomationDraft` and friends), `src/automations/draft-card.ts`, `confirm-card.ts`, `end-card.ts`, `card-body.ts`, `card-sequence.ts`, `operation.ts`, `manage-operation.ts`, `src/automations/store.ts` (draft API), `src/card/dispatcher.ts` (~411-529), new module (e.g. `src/automations/draft-confirmation.ts`), tests, `CONTEXT.md`.

## Why

A draft's card fields are written by six files. Three `post*Card` functions repeat the same sign → send → classify → bind choreography. The dispatcher has two confirm paths (operation-backed vs legacy). Recent fixes touch 4 to 8 files each.

## Do

1. Red: module tests with a temp `AutomationsStore`, the real Outbox and a recording channel: submit a create / replace / delete / end draft and see one card; flush is idempotent under concurrent callers; confirm / reject / end tap with a valid token applies once; replay, stale revision, expiry and wrong scope give the existing invalid response; settle after tap updates the card in place and retries a stale sequence; an applied outcome whose card cannot be updated sends one fallback reply (current behaviour from `ae9f4906`); expiry settles due drafts.
2. Green: one module with a small interface (submit, flush, handle a verified action, expire due). Token signing via D06, durable send via D02. Draft card fields become private to this module; callers stop importing `command.ts` internals.
3. Collapse the dispatcher's `auto.confirm` / `auto.reject` / `auto.end.*` branch into one call into this module. Drop the legacy (non-operation) path if no persisted draft can still need it after the D02 migration; otherwise migrate those drafts and then drop it.
4. Keep green: `tests/integration/bot/auto-*.test.ts`, `reminder-tools/*.test.ts`, `tests/unit/automations/*`. Delete tests that only pinned moved internals.
5. Update `CONTEXT.md` (draft confirmation). `/code-review`.

## Acceptance

- [ ] Only the draft confirmation module reads or writes draft card fields.
- [ ] One choreography for all draft card kinds; dispatcher calls one function for automation confirm actions.
- [ ] Tests in Do 4 green; `pnpm ci:local` green; delivery note posted.
