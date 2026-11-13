# run-terminal-truth — dual-track board

Spec: [docs/specs/run-terminal-truth.md](../../docs/specs/run-terminal-truth.md)

Docs PR #71 (`docs/run-terminal-truth`) is read-only input for code PR #70. Never merge the docs PR or copy this tree into the code branch.

| # | Ticket | Blocked by | Status / next action |
|---|--------|------------|----------------------|
| 01 | [Capture redacted raw terminal result (antigravity)](issues/01-capture-terminal-result.md) | — | See ticket/delivery notes |
| 02 | [Fix current-turn error attribution](issues/02-turn-attribution.md) | 01 | See ticket/delivery notes |
| 03 | [done never downgraded by stderr signature + log rename](issues/03-done-not-downgraded.md) | — | Done @ `f3dc2b51` (verified in #70) |
| 04 | [Awake-time watchdog and non-shortening recovery](issues/04-recovery-deadline.md) | — | Partially implemented: keep `6904cee6`, `64acee7e`; finish revised acceptance |
| 06 | [Real tool lifecycle evidence across every CLI](issues/06-agy-tool-events.md) | — | Ready; capture real events before mapping changes |
| 07 | [Bound per-tool grace; ignore heartbeat-only liveness](issues/07-bounded-tool-grace.md) | 04, 06 | New; blocked |
| 08 | [Config takes effect + CLI hard-timeout ownership](issues/08-config-cli-timeout.md) | 04, 06, 07 | New; blocked until bridge watchdog protection is proven |
| 09 | [Partial terminal state + duplicate failure text](issues/09-partial-terminal-dedup.md) | — | Ready; add error + exit 3 + timeout signature regression |
| 05 | [Feishu E2E (Bot Arena)](issues/05-feishu-e2e.md) | 02, 03, 04, 06, 07, 08, 09 | Final acceptance after revised watchdog tickets |
| 10 | [Comment error replies always say "Claude"](issues/10-comment-error-agent-label.md) | — | New; not in scope for #70 (pre-existing on master) |
| 11 | [Comment new-session notice wrong while another comment holds a newer session](issues/11-comment-stale-fresh-session-notice.md) | — | New; not in scope for #70 (follow-up to 02) |
| 12 | [agy ERROR: deliver answer or rerun once in a fresh session](issues/12-agy-error-auto-recover.md) | — | On hold, observe first (user 2026-11-11); instances 2026-11-13 15:08, 15:14, 15:46, 15:55 (new error forms, still not implementing) |

2026-11-08 (Asia/Shanghai): Q1 per-tool awake cap (60-minute default, normal-idle floor); Q2 heartbeat-only liveness never extends runs; Q3 child model waits use normal idle. Spec records the decisions and host-resume versus bridge-restart boundary. Earlier 04 commits are preserved but do not prove the revised sleep/tool requirements.

Execution order: finish 04 and real-event verification/mapping in 06, then 07 and 08; 09 is independent and ready. Run final 05 once all its blockers are done. One ticket = one fresh session with /implement, /tdd and in-session /code-review. Comment `claiming <ID>` / `done <ID> @ <sha>` on the docs PR. Push product code only to #70; normal merge by the user, no squash or force-push. Close #71 unmerged after #70 ships.

19:13 incident follow-up (2026-11-08, Asia/Shanghai): Spec now includes configuration/reload boundaries and CLI hard-timeout ownership (08), plus partial-to-presentation normalization (09). Ticket 06 first captures agy 1.5.3 sanitized NDJSON and keeps bridge tool pairing separate from the CLI's own running-background-task list. No artifact-delivery, upload or size-limit ticket is added. No production restart/config change is authorized.

2026-11-08 19:50 (Asia/Shanghai): user-endorsed room conclusion recorded as Spec Q4–Q9 (one watchdog incl. comment tasks; model output never cancels an open tool; agy background tasks only from structured signals; early tool signals never skip safety; "budget used up" wording; CLI whole-turn cap default off). Folded into 05–09; no new ticket.
