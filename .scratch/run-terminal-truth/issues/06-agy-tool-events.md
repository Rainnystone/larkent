# 06: Verify real tool lifecycles across every CLI adapter

**Blocked by:** None · **Status:** ready-for-agent

Read Spec D5 and Q1–Q3. This ticket is wider than antigravity. `src/agent/antigravity/jsonl.ts` maps tool/checkpoint events to liveness, which currently refreshes activity but does not open tool grace. Do not repeat the claim that translated liveness never reaches the watchdog. Also inspect `src/agent/codex/jsonl.ts` (only command execution appears mapped; MCP/search/file-change coverage needs evidence) and `src/agent/devin/transcript.ts` (a start without ready `rawInput` may remain liveness-only).

## Evidence gate: before changing any adapter mapping

Capture real, redacted CLI events for antigravity, codex, claude, cursor, grok, kimi, and devin on the test setup. Record CLI version, capture method, event shapes and pairing evidence in delivery notes. A checked-in fixture can be synthetic: in particular, `tests/fixtures/antigravity/tool-checkpoint-steps.jsonl` is not by itself proof of real output. Never invent fixture events to justify a mapping. If a capture is unavailable or the lifecycle is ambiguous, report the exact gap and leave that adapter acceptance incomplete; do not silently waive universal tool coverage or guess a start/finish.

## What to build, after evidence

Map verified starts and terminal tool events to `tool_use`/`tool_result`. For agy, pair by `(conversation_id, step_index)`: ACTIVE opens, DONE/verified terminal state closes. Scope supersession to the same conversation/sub-agent: a higher step index closes an older ACTIVE step only where real output proves supersession. Guard against nested/sub-agent steps reusing an index or conversation identity; use captured `subagent_info` to disambiguate. Never close a sibling's tool. A status/checkpoint ping alone is not a new tool start.

For codex, verify command, MCP, web-search and file-change shapes rather than assuming unsupported items exist. For devin, verify a start before `rawInput` is ready and its later completion. Fix mappings where the capture proves a gap; retain correct adapters unchanged. Identify real progress versus status-only liveness and sub-agent ancestry for ticket 07: a child waiting on the model must use normal idle even if its parent Task/tool remains open.

## Acceptance
- [ ] Real redacted captures and provenance precede mapping changes for every adapter; no claim of coverage based solely on synthetic fixtures.
- [ ] agy paired lifecycle and supersession tests use the verified `(conversation_id, step_index)` identity; reused indices in concurrent/nested sub-agents do not collide or get swallowed as liveness.
- [ ] Codex captures explicitly establish which command/MCP/search/file-change items exist and are tools; map verified gaps. Devin's verified pre-input start gets tool grace without waiting for ready input or completion.
- [ ] One parametrized watchdog test runs each adapter's real captured fixture: antigravity, codex (including verified MCP tools), claude, cursor, grok, kimi, devin. At default 15-minute idle, a tool starts, remains silent and is alive after 16 awake minutes, then stops after its 60-minute awake cap (check at 61 minutes). Also prove matching completion returns to ordinary idle.
- [ ] Real model/answer progress is distinguishable from heartbeat-only liveness; sub-agent model-wait evidence and available parent identity are recorded for Q3/ticket 07. Unavailable ancestry is an explicit gap, not permission to grant every child wait 60 minutes.
- [ ] `pnpm ci:local` green; delivery notes map each adapter to its capture and regression tests.
