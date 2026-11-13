# 12: agy ERROR — deliver the answer if there is one, otherwise rerun once in a fresh session

**Blocked by:** None · **Status:** on hold — observe first (user, 2026-11-11). Implement only if the problem recurs or agy shows a new error form. · **Scope:** follow-up to #70 (merged as `1dfe8982`); new code PR when started.

## Decisions (user, 2026-11-11 morning, Asia/Shanghai)

- The agy whole-turn cap (`--print-timeout`) stays on as the only guard against hangs, loops and runaway thinking cost. 哈基米 (`profiles.cursor`) cap is 90m (Keeper applied 09:53); bridge watchdog stays 15m awake idle, 60m per-tool grace.
- No whole-turn cap for Grok, Devin or other CLIs; the bridge watchdog is enough.
- Keep the 2026-11-10 02:58 decision: after `print_timeout` the session is kept (not discarded). Dropped from this ticket.

## What to build

1. agy ends with ERROR **and** produced an answer this turn: deliver the answer as a normal reply, then discard the session.
2. agy ends with ERROR and **no** answer: automatically rerun the prompt once in a fresh session; if that also fails, show a clear error. No user click needed.
3. Show the 继续/暂不 card only when the session is still usable. When the session was discarded, do not offer 继续. After a `print_timeout` with a healthy session, keep showing the card.
4. Typing reaction sometimes is not removed after the run ends (reported in the 2026-11-11 room discussion; capture a reproducing trace before fixing).

Do not change which `finished_reason` values keep the session (`interrupted`, `print_timeout`; `src/agent/antigravity/jsonl.ts:152-170`). Unknown reasons keep falling back to discard.

## Instances

- 2026-11-13 15:08:34 (Asia/Shanghai), group `…8c1372`, run `d21c4043…`: fact-check task, ERROR `API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read tcp …: read: connection timed out`, numTurns 16, no answer delivered. No tool progress from ~14:58; the box slept 14:48–14:53 with ws-down. Bridge outcome `failed:transient-upstream`, Typing removed, 继续 card shown; the user clicked 继续 at 15:09 (new run `8a289698`). Point 2 would have rerun automatically. Not a print timeout or stream interruption; not a new agy error form (agy 1.5.8). Reported by Keeper.

## Acceptance

- [ ] ERROR with answer: answer delivered, session discarded, no 继续 card.
- [ ] ERROR without answer: exactly one automatic fresh-session rerun; a second failure shows one clear error and no rerun loop.
- [ ] `print_timeout` / `interrupted`: session kept, 继续 card unchanged.
- [ ] Typing reaction removed on every terminal path, with a regression test from the captured trace.
- [ ] Local gate green; Feishu test-bridge check with 「Agent测试专员」 only.
