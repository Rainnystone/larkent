# 06: Verify real tool lifecycles across every CLI adapter

**Blocked by:** None · **Status:** ready-for-agent

Read Spec D5, D7 and Q1–Q3. Code line references below are from docs-track commit `b8adcd46`; locate the same functions if implementation has moved them. This ticket is wider than antigravity. `src/agent/antigravity/jsonl.ts` maps tool/checkpoint events to liveness, which currently refreshes activity but does not open tool grace. Do not repeat the claim that translated liveness never reaches the watchdog. Also inspect `src/agent/codex/jsonl.ts` (only command execution appears mapped; MCP/search/file-change coverage needs evidence) and `src/agent/devin/transcript.ts` (a start without ready `rawInput` may remain liveness-only).

## Evidence gate: before changing any adapter mapping

Capture real, redacted CLI events for antigravity, codex, claude, cursor, grok, kimi, and devin on the test setup. Record CLI version, capture method, event shapes and pairing evidence in delivery notes. A checked-in fixture can be synthetic: in particular, `tests/fixtures/antigravity/tool-checkpoint-steps.jsonl` is not by itself proof of real output. Never invent fixture events to justify a mapping. If a capture is unavailable or the lifecycle is ambiguous, report the exact gap and leave that adapter acceptance incomplete; do not silently waive universal tool coverage or guess a start/finish.

### agy 1.5.3: answer two different questions

Capture this installed version's real, sanitized stdout NDJSON first. The checked-in real long-tool capture is from 1.4.8 (`tests/fixtures/transcripts/antigravity/long-tool.jsonl:1,8–12`); it shows ACTIVE/DONE and a later system_message but is not proof of 1.5.3 behavior. Record state, conversation/step identity and tool_info shape without exposing payload secrets.

1. **Bridge-side state:** `src/agent/antigravity/jsonl.ts:84–102` maps both ACTIVE and DONE tool/checkpoint steps to liveness, ignoring their state and output; system_message is ignored at 92–94. The bridge therefore has no paired tool state to give agy tool grace (`src/bot/idle-watchdog.ts:84–91` consumes tool_use/tool_result). Fix this mapping only after capture establishes the lifecycle.
2. **agy's own background-task list:** at the 2026-11-08 19:13:35 timeout (Asia/Shanghai), agy still listed task-422 as running and terminated it. This is CLI-owned state, not the bridge's tool table. Separately inspect real agy task logs, task exit evidence and completion notifications. Determine whether the CLI emitted completion, retained a stale task, or the whole shell still had work remaining. Fixing bridge ACTIVE/DONE mapping does not explain or fix this list. If CLI bookkeeping is wrong, document an upstream agy issue with sanitized evidence; do not patch the CLI or invent a bridge workaround here.

Incident references: `~/.lark-channel/profiles/cursor/logs/bridge-20261108.jsonl:1031–1034` (timeout plus running task), `:1042–1043` (later cleanup), `:1052–1058` (exit 3 / partial / error rendering). agy log `~/.gemini/antigravity-cli/log/cli-20261108_190234.log:383–387` records timeout and cancellation. All times are Asia/Shanghai. The original stdout NDJSON was not captured, so neither “CLI never emitted completion” nor “bridge dropped this incident's completion” is proven. Do not read credentials or app databases to fill that gap.

### Keep diagnosable stdout evidence

Add an opt-in test-bridge diagnostic capture around raw stdout before translation (`src/agent/runner/jsonl-cli-runner.ts:529`). Persist real NDJSON structure after redaction, with version/run identity, restricted file permissions, bounded size/retention and explicit truncation/error records. Do not persist unredacted stdout, prompts, tokens, sensitive tool arguments or outputs. Redact before writing; test that secrets never reach the capture file. Keep existing runner size limits and stdout drainage intact. No production enablement or bridge restart is authorized by this ticket.

## What to build, after evidence

Map verified starts and terminal tool events to `tool_use`/`tool_result`. For agy, pair by `(conversation_id, step_index)`: ACTIVE opens, DONE/verified terminal state closes. Scope supersession to the same conversation/sub-agent: a higher step index closes an older ACTIVE step only where real output proves supersession. Guard against nested/sub-agent steps reusing an index or conversation identity; use captured `subagent_info` to disambiguate. Never close a sibling's tool. A status/checkpoint ping alone is not a new tool start.

For codex, verify command, MCP, web-search and file-change shapes rather than assuming unsupported items exist. For devin, verify a start before `rawInput` is ready and its later completion. Fix mappings where the capture proves a gap; retain correct adapters unchanged. Identify real progress versus status-only liveness and sub-agent ancestry for ticket 07: a child waiting on the model must use normal idle even if its parent Task/tool remains open.

## Acceptance
- [ ] Sanitized real agy 1.5.3 NDJSON is captured before mapping changes; version, method and provenance are recorded. ACTIVE/DONE pairing is established rather than borrowed from the 1.4.8 sample.
- [ ] Bounded opt-in test-bridge stdout capture preserves diagnostic event structure before translation, redacts before persistence, and tests permissions, limits, truncation and secret non-disclosure.
- [ ] Delivery notes give two separate conclusions: bridge lifecycle mapping and agy's own task-422 bookkeeping. For each, distinguish emitted, ignored, unavailable and unverified evidence. A bridge fix must not be reported as fixing agy's running-task list; any upstream gap remains explicit.
- [ ] Real redacted captures and provenance precede mapping changes for every adapter; no claim of coverage based solely on synthetic fixtures.
- [ ] agy paired lifecycle and supersession tests use the verified `(conversation_id, step_index)` identity; reused indices in concurrent/nested sub-agents do not collide or get swallowed as liveness.
- [ ] Codex captures explicitly establish which command/MCP/search/file-change items exist and are tools; map verified gaps. Devin's verified pre-input start gets tool grace without waiting for ready input or completion.
- [ ] One parametrized watchdog test runs each adapter's real captured fixture: antigravity, codex (including verified MCP tools), claude, cursor, grok, kimi, devin. At default 15-minute idle, a tool starts, remains silent and is alive after 16 awake minutes, then stops after its 60-minute awake cap (check at 61 minutes). Also prove matching completion returns to ordinary idle.
- [ ] Real model/answer progress is distinguishable from heartbeat-only liveness; sub-agent model-wait evidence and available parent identity are recorded for Q3/ticket 07. Unavailable ancestry is an explicit gap, not permission to grant every child wait 60 minutes.
- [ ] Per CLI, delivery notes list which events are real progress and which are heartbeat-only, with the capture line that proves each (input for 07). agy background tasks: record whether 1.5.3 emits structured start/end; if not, record the known gap (Spec Q6). A live child process is noted as auxiliary only.
- [ ] `pnpm ci:local` green; delivery notes map each adapter to its capture and regression tests.
