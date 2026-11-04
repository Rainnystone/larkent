# 01 — Reproduce and root-cause 300307; stop unbounded retry

Blocked by: none. Spec: §1.1, §2, D3, D4, §5.

## What
1. Reproduce 300307 against a **test** Feishu app/chat (never a live bridge):
   capture the exact request body `updateCardByCardId()` sends for a board
   card and the response. Write the root cause with evidence in the code PR
   description (Verification).
2. Add a failing test that encodes the cause, then fix the payload/request at
   that cause.
3. Make a Feishu-coded rejection of a board update terminal: log once per
   (chat, code), no further update attempts for that chat until a real task
   change — even if rendered content drifts or the process restarts.

## Acceptance
- [ ] Root cause stated with captured request/response evidence (secrets redacted); not "empty list".
- [ ] A test that failed before the fix reproduces the 300307 condition and passes after.
- [ ] Test: fake channel returns 300307 for every update; N refreshes with changing content → exactly 1 update call and 1 `board` fail log.
- [ ] Test: after simulated restart (new `Board` over same store) no retry until `onChanged`-driven refresh.
- [ ] Existing `tests/unit/automations/board-*.test.ts` and `auto-board-card.test.ts` green.
