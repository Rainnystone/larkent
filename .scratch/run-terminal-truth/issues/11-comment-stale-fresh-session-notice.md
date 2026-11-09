# 11: Comment new-session notice can be wrong while another comment holds a newer session

**Blocked by:** None · **Status:** ready-for-agent · **Scope:** not in scope for code PR #70 (filed from the #70 review round 7; follow-up to ticket 02)

## Symptom

Comments A and B run concurrently in one document. A resumes conversation `old`; B starts fresh and stores `new`. A then hits an attached agy ERROR, so its reply appends `下一条消息将开始新会话`. But the next comment C resumes B's healthy `new`, so the notice on A's reply is false. Nothing breaks; the user is told the wrong thing.

## Evidence

- `src/bot/comments.ts:339–341` (`5d7aa444`; `:338–340` at `8c518a7e`) sets `sessionDiscarded = true` on any `invalidateResume`, and `:421` appends the notice from that flag alone.
- The next comment's resume selection is `src/bot/comments.ts:242–263` (catalog `activeFor`, then the SessionStore fallback). It can still find `new`.
- `discardRunResumeHandle` (`src/bot/run-flow.ts`) archives only catalog rows holding the poisoned handle, and since `2267c859` clears the SessionStore only while it holds that handle. So `new` intentionally survives (review finding F1).

## Where it reproduces

- Not on master `2b2c2ea2`: master has no new-session notice (it arrived with ticket 02, `c61b7e21`).
- Code PR #70 `8c518a7e`: yes, whenever a session catalog is present (catalog archiving was already handle-scoped).
- Code PR #70 `5d7aa444`: yes, with or without a catalog (F1 fix makes the store handle-scoped too, which is the intended behaviour).

Found by local Devin's round-7 review (box evidence `/workspace/rt-e2e-evidence-20261109/round7-review/REPORT.md` §3 T2, not committed).

## What to build

Decide the notice from the real post-discard state: extract the resume selection at `comments.ts:242–263` into one function, re-run it after `discardRunResumeHandle`, and append the notice only when no resumable handle remains for the next comment. Do not change the discard rules of ticket 02 (narrowed D2).

## Acceptance
- [ ] The F1 concurrency test in `tests/integration/comments/comment-run-flow.test.ts` additionally asserts that A's reply has no new-session notice while C resumes `new`; it fails before the fix.
- [ ] Single-comment agy ERROR (legacy `doc:<token>` and catalog paths) still shows the notice and the next comment starts fresh.
- [ ] Chat-path notice behaviour (round-6 E2E A2/B/C) is unchanged.
- [ ] Local gate green (same commands as ticket 10).
