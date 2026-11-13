# Delivery Note 03 review fixes: six findings from Bugbot, Devin, and Codex

Code branch (`fix/agy-error-recover`, PR #74) after ticket 03 (`5310b9dd219b983090dd6a4f52026d3c058fa34b`). One independent `fix(03)` commit per finding; no rewritten history.

## Commits (all pushed)

1. `4cbfb8646719aa568f2e0a57442348ad7cf9fc1c` — `fix(03): deliver fallback error or handoff when auto-rerun skips or fails to start`  
   Fixes Devin 4567467378 and Bugbot 4567485190: if Attempt 2 fails to start, or shutdown / a superseded session writer skips the rerun after Attempt 1 was suppressed, deliver one fallback error card (or unrecord the accepted batch for backfill on shutdown). No silence.

2. `bcb75003e3a80702127553aaeb6d4fa55e738efa` — `fix(03): preserve continuation and abandon instructions across fresh auto-rerun`  
   Fixes Bugbot 4567485174 and Codex 4567488543: a keep-session 继续 auto-rerun carries the original task, not bare `继续`; an abandon hint survives a topic-history refetch.

3. `3a45d7250c845e01360ae629777b49f8197a922c` — `fix(03): skip auto-rerun when CLI already sent to the chat`  
   Fixes Devin 4567467514: `shouldAutoRerunDiscardedError` returns false when `cliSelfSent` already recorded a send, or when the run already IM-sent to this chat via lark-cli.

4. `a19517cd8f2610a3d92acad57fcd7872d75e981d` — `fix(03): bound suppressed progress-stream wait and recall cleanup`  
   Fixes Codex 4567488530: suppressed stream finalization and recall use `outboundTimeoutMs` (`withOutboundTimeout`); a stalled producer cannot block the automatic rerun forever.

5. `66ea3c2717a7ec082f63d060a8afc55e638321cd` — `fix(03): honor /stop and cancellation between attempt 1 and auto-rerun`  
   Fixes Codex 4567488538: `ActiveRuns.trackPendingRerun` keeps `/stop` live in the gap after Attempt 1 unregisters and before Attempt 2 starts; a stop during topic-context fetch or Attempt 1 recall cancels Attempt 2 and delivers one clear error card.

6. `78576ff3e002641c64e7d5b2a5f4c469c83d6cfd` — `fix(03): suppress and recall first attempt CoT error bubble on auto-rerun`  
   Fixes Codex 4567488520: `consumeCotEvents` honors `shouldSuppressError`; a successful rerun recalls Attempt 1's CoT error bubble so only Attempt 2's bubble and recovered reply remain. A failed rerun still publishes `RUN_ERROR` and finishes Attempt 2's bubble as `error`.

Head at acceptance: `78576ff3e002641c64e7d5b2a5f4c469c83d6cfd`.

## Tests

`tests/integration/bot/agy-error-discards-resume.test.ts` grew from 10 to 22 cases (12 new regressions, one per scenario above, including both `/stop` gap timings and both CoT outcomes). Also: `tests/unit/bot/active-runs-lifecycle.test.ts` (`trackPendingRerun`) and `tests/unit/bot/cot.test.ts` (`shouldSuppressError` + `CotPublisher.cancel()`).

## Controller gate (2026-11-14 05:26:24–05:36:16 CST)

- `git diff --check`, `pnpm typecheck`, `pnpm build`: passed.
- `vitest run --maxWorkers=2 --minWorkers=1`: first full run 357 files passed, 7 skipped, 2 failed (366); 4107 tests passed, 16 skipped, 2 failed (4125). Failures: the known box Fake-IP issue in `tests/integration/e2e-harness/proxy.test.ts` (untouched); one timeout in `tests/integration/bot/feishu-parity.test.ts` (`pins the bot channel-call sequence for kimi`) under memory pressure. Isolated rerun of feishu-parity plus the review-fix and the two GitHub-red tests (confirm-action-latency, stall-after-recovery, 22 discards-resume cases, cot, active-runs-lifecycle) was 6 files / 59 tests passed at 05:37:38 CST. No leftover vitest or test-bridge processes after cleanup of one `e2e-hang` orphan from the full run.
- GitHub Actions on `78576ff3` (run 43508093190): ubuntu-latest shard 1 failed on `confirm-action-latency` (150ms race timed out) and `stall-after-recovery` (transition not observed). Neither test file is in the review-fix diff; both passed locally. Not rerun. Local gate is the source of truth (Actions quota still constrained). Other shards and static checks on that run passed.

## Unverified

- Live Feishu `rt1` still skipped: tester token missing at `/home/box/.lark-channel-e2e/rr2-tester/user-token`.
- In-session `/code-review` subagents were not re-run on the review fixes; the controller checked the six commits against the eight review comments and the added tests.
- Ticket 04 remains parked.
