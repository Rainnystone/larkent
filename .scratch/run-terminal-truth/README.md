# run-terminal-truth — dual-track board

Spec: [docs/specs/run-terminal-truth.md](../../docs/specs/run-terminal-truth.md)

Docs PR #71 (`docs/run-terminal-truth`) is read-only input for code PR #70. Never merge the docs PR or copy this tree into the code branch.

| # | Ticket | Blocked by | Status / next action |
|---|--------|------------|----------------------|
| 01 | [Capture redacted raw terminal result (antigravity)](issues/01-capture-terminal-result.md) | — | See ticket/delivery notes |
| 02 | [Fix current-turn error attribution](issues/02-turn-attribution.md) | 01 | See ticket/delivery notes |
| 03 | [done never downgraded by stderr signature + log rename](issues/03-done-not-downgraded.md) | — | See ticket/delivery notes |
| 04 | [Awake-time watchdog and non-shortening recovery](issues/04-recovery-deadline.md) | — | Partially implemented: keep `6904cee6`, `64acee7e`; finish revised acceptance |
| 06 | [Real tool lifecycle evidence across every CLI](issues/06-agy-tool-events.md) | — | Ready; capture real events before mapping changes |
| 07 | [Bound per-tool grace; ignore heartbeat-only liveness](issues/07-bounded-tool-grace.md) | 04, 06 | New; blocked |
| 05 | [Feishu E2E (Bot Arena)](issues/05-feishu-e2e.md) | 02, 03, 04, 06, 07 | Final acceptance after revised watchdog tickets |

2026-11-08 (Asia/Shanghai): Q1 per-tool awake cap (60-minute default, normal-idle floor); Q2 heartbeat-only liveness never extends runs; Q3 child model waits use normal idle. Spec records the decisions and host-resume versus bridge-restart boundary. Earlier 04 commits are preserved but do not prove the revised sleep/tool requirements.

Execution order: finish 04 and real-event verification/mapping in 06, then 07, then final 05 once its other blockers are done. One ticket = one fresh session with /implement, /tdd and in-session /code-review. Comment `claiming <ID>` / `done <ID> @ <sha>` on the docs PR. Push product code only to #70; normal merge by the user, no squash or force-push. Close #71 unmerged after #70 ships.
