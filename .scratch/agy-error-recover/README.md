# agy ERROR recovery — Spec

**Docs track only.** Supersedes ticket 12 on `docs/run-terminal-truth` (closed PR #71). Evidence for the four 2026-11-13 instances (15:08, 15:14, 15:46, 15:55 Asia/Shanghai) stays there:
`git show origin/docs/run-terminal-truth:.scratch/run-terminal-truth/issues/12-agy-error-auto-recover.md`

## Problem

When agy (Antigravity CLI, bot 哈基米, profile `cursor`) ends a turn with `status: ERROR`, the bridge treats the whole turn as failed, discards the session, and shows a 继续/暂不 card, whatever actually happened:

- **Answer written, then ERROR** (15:14, 15:46). The user sees a complete reply, then `⚠️ agent 失败…` and a 继续 card. The run counts as failed even though the work is done. 15:46 shows the ERROR can be *sticky*: a mid-run `The stream was interrupted` (box sleep at 15:40) leaks into the final print result after agy recovered and finished.
- **No answer, then ERROR** (15:08 TCP timeout after box sleep; 15:55 `FAILED_PRECONDITION … User location is not supported`, `retryable: false`). Each time the user clicked 继续 and a fresh session succeeded. A human click was the only recovery.
- **继续 overpromises.** After an unknown ERROR the session is discarded, so 继续 replays the prompt in a *new* conversation. The card implies it continues the old one.
- **Diagnosis gap.** `terminal-result` logs neither `finished_reason` nor whether agy returned `result.response` / held-back answer text, so from logs alone we cannot tell a full answer from a fragment.

## Mechanism today (`origin/master` 9a49a148)

- `src/agent/antigravity/jsonl.ts` `translateResult`: on `ERROR`/`FAILED` it ignores `result.response`, emits an `error` terminal, and sets `invalidateResume` unless `finished_reason` is `interrupted` or `print_timeout`.
- `src/agent/final-answer/core.ts`: held-back `agent_response` deltas are flushed as progress before the error terminal, which is why the answer reaches the card.
- `src/bot/run-outcome.ts` + `src/bot/interruption-notice.ts`: a retriable failure gets a `continue` notice. The "network interrupted" label comes from `applyOutageOverlap` (Feishu ws reconnect during the run), not from the error text.
- `invalidateResume` is produced **only** by the agy adapter today. Shared-layer behaviour keyed on it affects agy alone in practice; keep it generic anyway.

## Decisions

- Keep: `interrupted` and `print_timeout` keep the session, and the 继续 card stays as is (user 2026-11-10/11). Unknown `finished_reason` still discards.
- Keep: agy whole-turn cap (`--print-timeout`, 90m on `profiles.cursor`) is the only hang guard; no new caps.
- New: ERROR **with** an answer is a delivered reply, not a failure card. Session discarded; no 继续.
- New: ERROR **without** an answer gets **exactly one** automatic fresh-session rerun, including errors agy marks `retryable: false` (15:55 proved such a 400 can be transient; Keeper and Orchestrator agreed 2026-11-13; cost is bounded at one rerun). A second failure shows one clear error, no card, no loop.
- New: the rerun is a programmatic 继续. It reuses the existing continue prompt (`CONTINUE_HINT`: check completed steps, do not repeat side effects) because the failed turn may already have run tools.
- New: when the session was discarded, never show 继续.

## Non-goals

- Typing reaction left behind (old point 4): shared layer, not agy-specific, no reproducing trace yet → ticket 04, parked.
- Proxy/egress changes, agy account or config (Keeper's), changing which `finished_reason` values keep the session.

## Tickets

| # | Ticket | Blocked by | Owner |
|---|---|---|---|
| 01 | [Log agy terminal facts](issues/01-log-agy-terminal-facts.md) (tracer) | — | agy |
| 02 | [ERROR with answer → deliver, discard, no 继续](issues/02-error-with-answer-delivers.md) | 01 | agy |
| 03 | [ERROR without answer → one fresh rerun](issues/03-error-without-answer-reruns-once.md) | 01 | agy |
| 04 | [Typing reaction left behind](issues/04-typing-reaction-left-behind.md) | trace | parked |

One ticket = one fresh session. Claim with `claiming <ID>` and finish with `done <ID> @ <sha>` on the docs PR.

## Done gate (every ticket)

`pnpm ci:local` green on the code branch head (GitHub Actions unavailable until ~December), red-before-green tests at the seam the ticket names, in-session `/code-review`, and a test-bridge check (`pnpm e2e:*`, instance `rt1`, tester 「Agent测试专员」, prefix 【端到端测试】) where the ticket asks for one. Delivery note per ticket in `delivery-notes/`.
