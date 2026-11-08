# 07: Bound per-tool grace and ignore heartbeat-only liveness

**Blocked by:** 04, 06 · **Status:** blocked

Read Spec D5 and Q1–Q3 (2026-11-08). Use ticket 04's shared awake-time activity path and ticket 06's verified adapter events. Do not add a heartbeat layer or reset budgets on status pings.

## What to build

Track each tool's own start in awake time. The default cap is 60 minutes from that start, not 60 minutes since the latest event. Use `max(60 minutes, configured normal idle)` when idle is enabled, as defined in 04. Retire expired tool entries even when `tool_result` never arrives; later events cannot renew that id. A later, genuinely new tool has its own budget. Main-conversation output resets normal idle but does not close an open tool or move its cap (Spec Q5); the tool ends only on its own verified end or at its cap. Apply the same watchdog to document-comment tasks (Q4). Early start signals must not skip or reorder the automation policy guard (Q7). On expiry the stop message says the waiting budget was used up, names the timer (normal idle or which tool's grace) and the awake minutes (Q8).

Separate genuine progress (text, thinking, tool lifecycle, held-back answer deltas) from heartbeat-only liveness (retry, connection, status/version pings). Inspect `src/bot/turn.ts:652–654`: unconditionally calling `noteRunEvent`/rearming on liveness is the bug, not a contract to preserve. Apply the distinction through the shared seam, including meetings. Progress may refresh normal idle; neither progress nor heartbeat moves an existing tool's cap.

Sub-agent model waits count against normal idle (Q3). A parent Task/tool staying open does not grant the child model wait 60 minutes. Use verified ancestry such as Claude `parent_tool_use_id` and agy `subagent_info`; preserve grace for a real tool running inside the child. Missing identity or phase evidence must be documented and resolved, not hidden by treating every nested operation as a long tool.

## Acceptance
- [ ] An unpaired `tool_use` loses grace at its awake cap; heartbeat/progress events do not move its start or reopen the expired id. It cannot grant 60-minute waits forever.
- [ ] Lost result, then model output, then silence: the open tool still stops at its own awake cap (Q5), not earlier and not later; once it is retired, model-only silence uses normal idle. Concurrent tools retain independent starts; a new tool cannot renew an older tool.
- [ ] Heartbeat-only liveness every 30 seconds for two hours never extends a run: model-only silence stops at normal idle; a real open tool stops at its original awake cap. Include retry/connection/status examples from verified adapters.
- [ ] Genuine progress, including held-back answer deltas, still refreshes normal idle; do not fix heartbeat handling by discarding all liveness.
- [ ] With the parent tool open, a sub-agent waiting on the model stops at normal idle; a verified tool inside that child gets its own tool budget. Test Claude and agy ancestry/collision cases from 06.
- [ ] Suspend, late recovery, and clock changes do not renew any per-tool cap. Configured idle longer than 60 minutes respects the 04 floor; disabled idle arms no deadline.
- [ ] Document-comment tasks hit the same budgets as chat (Q4). A tool opened from an early start signal still passes through the automation policy guard before it runs (Q7).
- [ ] Stop text: "waiting budget used up" wording, timer name and awake minutes; no "stuck" wording (Q8).
- [ ] agy background tasks get tool grace only from verified structured start/end (Q6); a live child process alone never opens or extends grace.
- [ ] `pnpm ci:local` green; delivery notes list the tests proving each decision.
