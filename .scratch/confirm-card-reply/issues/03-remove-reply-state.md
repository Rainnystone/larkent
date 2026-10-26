# 03 — Remove reply-state; settle-path fallback

Spec: `docs/specs/confirm-card-reply.md` (Problem row 6, Approach T3, Non-goals).
Blocked by: 02.
Code branch: `feat/confirm-card-reply`. Touch `src/automations/**`, the automation-notice wiring in `src/bot/channel.ts`, and tests.

## Do

1. Red: regression test — a draft is confirmed while the reply is generated; the final reply is delivered byte-for-byte unchanged (no 「回复生成期间…」 line).
2. Red: settle tests (below) against `settleDraftCard` (`src/automations/draft-card.ts`) with a channel whose card update fails.
3. Green: delete `src/automations/reply-state.ts` and its tests; remove `trackAutomationReply` (caller `src/bot/channel.ts` ~1834) and the automation notice passed into `appendOutcomeNotice` (~2062, ~2565-2566, ~2620). Keep `appendOutcomeNotice` itself for its other callers.
4. Green: on in-place update failure for an applied outcome (confirmed create, applied replace, applied delete), reply to the card message once with fixed text, e.g. `确认卡未能更新：已确认 #N`, built from `draftConfirmedStatus`/`draftReplacedStatus`/`draftDeletedStatus`. Persist "fallback sent" per operationId in the automations store; log a warning; no retry loop.
5. `/code-review`.

## Acceptance

- [ ] No `reply-state` / `trackAutomationReply` references remain (`rg` clean).
- [ ] Confirmed during generation → reply unchanged.
- [ ] Update fails on confirm/replace/delete → exactly one reply to the card message with the fixed text.
- [ ] Settling twice, or after restart → still one message (persisted per operationId).
- [ ] Update fails on expiry, supersede or cancel → no message.
- [ ] Successful update → no message.
- [ ] TTL (`AUTOMATIONS_DRAFT_TTL_MS`) unchanged. Other automations and channel tests green. CI green on the code PR head.
