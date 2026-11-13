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
- 2026-11-13 15:14:07 (Asia/Shanghai), same group, rerun `8a289698…` / trace `rfi565ex` (the user's 继续 from the instance above): agy finished the answer (tool calls 15:12–15:13, answer streamed to the card), then ERROR `API error (attempt 1): failed to get load code assist response: Post "…/v1internal:loadCodeAssist": read tcp …: read: connection timed out`, numTurns 1, exit 0. Bridge outcome `failed:transient-upstream`, card final `error`, 继续 notice sent (`consecutive: 2`). The answer was delivered, so this is a point-1 instance: the user saw a reply followed by an interruption notice. The box slept ~15:08:59–15:09:37 as this run started (see Investigation point 5); not a network fault.

## Investigation 2026-11-13 (read-only, production `1dfe8982`; no code changed)

User asked to verify, debug and record only, not implement.

1. **Why a reply appears and then the interruption notice.** On an agy ERROR result the parser ignores `result.response` (`src/agent/antigravity/jsonl.ts:152-170`) and the final-answer core flushes the held-back `agent_response` deltas as progress text (`src/agent/final-answer/core.ts:85-92`, `answer = this.progress()`), then emits the error terminal. So the text the model already wrote is pushed to the card (log: `progress-stream-open` 15:14:07.450, right after `terminal-result`), the card ends `terminal: error`, and because the outcome is retriable a `continue` notice follows (15:14:11, `consecutive: 2`). The answer is shown, but the run is still counted as failed.
2. **The transient label came from the Feishu link outage, not from the error text.** `read: connection timed out` matches none of `NETWORK_TRANSIENT_SIGNATURES` (`src/agent/cli-signatures.ts:25-57`: TLS socket, ECONNRESET, EPROTO/ERR_SSL, EAI_*/ENOTFOUND, ENETUNREACH/EHOSTUNREACH). Both runs became `failed:transient-upstream` only via `applyOutageOverlap` (`src/bot/run-outcome.ts:177-182`) because the Feishu WebSocket reconnected during the run (15:09:37 `wake-reconnect` in `rfi565ex`; ws-down during the 14:48 sleep in `wjvhot8v`). The same agy error without a link outage would be `failed:unclassified` ("agent 运行失败").
3. **The 继续 card restarts in a fresh session.** Neither ERROR had `finished_reason` `interrupted`/`print_timeout`, so the session was discarded; the 继续 run `rfi565ex` and the next message's run `8z3en4pp` both logged `session fresh`. 继续 here re-sends the prompt in a new conversation rather than continuing one — the card wording promises more than happens (point 3).
4. **Diagnostic gap.** `terminal-result` logs status, error, conversation and numTurns but not whether `result.response` or held-back text was non-empty, nor `finished_reason`. From logs alone we cannot tell whether the delivered text was the full answer or a fragment. Closing that gap (log response/held-text lengths and `finished_reason`) is a prerequisite for safely implementing point 1. For the 15:14 instance specifically, the quoted card injected into the next run (`8z3en4pp`, msg `om_x100b605f39fb…`) shows the full fact-check answer, followed by the bridge-appended `⚠️ agent 失败:网络连接中断，可稍后继续` and `下一条消息将开始新会话`; so that answer was complete.
5. **Upstream cause: box sleep (Coder, 2026-11-13 15:16).** All three bridges logged wake-reconnects at 15:06:14 (slept ~4m19s from ~15:01:55, inside run `wjvhot8v`) and 15:09:37 (slept ~38s from ~15:08:59, right as `rfi565ex` started at 15:09:01). agy kept using upstream connections that died during sleep, so its later calls (`streamGenerateContent`, then `loadCodeAssist` at 15:14) hit TCP read timeouts. Awake re-test: 5/5 requests to `daily-cloudcode-pa.googleapis.com` in 30–40 ms via `198.18.0.1`; network/proxy not at fault. Re-check the proxy only if the same timeout appears with no sleep in the run window.

## Acceptance

- [ ] ERROR with answer: answer delivered, session discarded, no 继续 card.
- [ ] ERROR without answer: exactly one automatic fresh-session rerun; a second failure shows one clear error and no rerun loop.
- [ ] `print_timeout` / `interrupted`: session kept, 继续 card unchanged.
- [ ] Typing reaction removed on every terminal path, with a regression test from the captured trace.
- [ ] Local gate green; Feishu test-bridge check with 「Agent测试专员」 only.
