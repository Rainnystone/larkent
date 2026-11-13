# 03: ERROR without an answer → one automatic fresh-session rerun

**Blocked by:** 01 (independent of 02) · **Owner:** agy

## What to build

When agy ends with `ERROR`/`FAILED`, the session is discarded, and there is no answer, the bridge reruns once by itself in a fresh session, as if the user had clicked 继续: same continuation prompt (`CONTINUE_HINT`), same chat/thread, same card flow. Applies regardless of agy's `retryable` flag. If the rerun also fails, show one clear error and **no** 继续 card. Never more than one automatic rerun per user turn.

Also: whenever a terminal carried `invalidateResume` (session discarded), do not show the 继续 card on any path.

Keep the shared-layer change generic (keyed on the terminal facts, not on the agent name) and as small as the design allows. Check `src/bot/channel.ts` continuation, `src/bot/continuation.ts`, `src/bot/interruption-notice.ts`, `src/bot/run-outcome.ts` before choosing the seam.

## Acceptance

- [ ] No-answer ERROR → exactly one fresh rerun; the user sends nothing.
- [ ] Rerun succeeds → one normal reply, no failure card.
- [ ] Rerun fails → one clear error, no 继续, no third run.
- [ ] Session discarded → no 继续 card anywhere; `print_timeout`/`interrupted` keep today's card.
- [ ] /stop or a superseding message during the rerun behaves like a normal run.
- [ ] Test bridge (`rt1`): force a no-answer ERROR (shim fault or `proxy disconnect --host daily-cloudcode-pa.googleapis.com` on the test bridge only) and show the rerun.
