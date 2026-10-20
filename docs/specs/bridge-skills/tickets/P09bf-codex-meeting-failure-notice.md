# Task 09bf — Codex meeting terminal failure produces no reply

**Status:** held — shared meeting finding, excluded from the current Codex-specific compatibility implementation. Not dispatchable.
**What to build (future shared review only):** deliver one safe terminal-failure notice through the existing meeting caller/broadcast route; no product repair is currently authorized.
**Specification:** [P09be/P09bf follow-ups](../codex-meeting-followups.md).
**Scheduling:** no current implementation slot. The earlier P09bc → P09bd → P09be → P09bf queue is historical and was scheduling, not functional dependencies.
**Priority:** proposed P2.
**Responsibility:** shared meeting terminal-outcome delivery, reproduced through Codex; not an adapter-specific defect. The upstream failure itself is not a bridge authentication/provider responsibility.
**Blocked by:** explicit future authorization for shared meeting changes. No functional ticket dependency on P09be/P09bc/P09bd. Current scope does not authorize an adapter-specific workaround.
**Audit:** [evidence index](../codex-compatibility-audit.md), 2026-10-20.
**Fixed code:** PR52 `feat/bridge-skills` at `8949a2d1c4339a777b1c4ff04af8443d5272e75b`.
**Versions:** larkent package 0.7.0; Node 24.19.0; installed Codex CLI 0.159.2 (help/version only); controlled executable 0.0.0-pin. Official Codex `rust-v0.159.2` source: `ff6aec96948b70d94983af2641a6b67c94faeff5`.
**Pre-publication check:** read the later P09bc code/test change at `2e64fa0a634b8934d2d3dc98a41940149692dd53`. The meeting/adapter paths are unchanged; the portable probe was rerun on a separate export of that head and still reproduces. The frozen audit baseline remains the SHA above.

## Problem and user stories

A participant asks Codex a question during a meeting. Codex ends the turn with a terminal failure before producing answer text, for example after an upstream request failure. The bridge logs that error but sends no answer or failure notice to either configured destination. The participant cannot distinguish failure from an ignored question or a still-running task.

1. As a participant, I want a failed meeting request to finish with a clear safe notice, so that I can distinguish failure from an ignored or running request.
2. As a caller using a meeting command, I want the failure result returned without direct meeting broadcast, so that the command can reply in its original requesting chat.

## Observed evidence and inference

Run the [shared sanitized evidence artifact](../evidence/codex-meeting-reproduction.md#run-the-historical-probe) with mode `failure`. The controlled child emits `thread.started`, then `turn.failed` with `Synthetic upstream failure`, and exits 1. The real Codex adapter, shared runner, executor and meeting consumer are used. This is a normal admitted meeting fixture; delivery uses recording doubles.

Observed twice: terminal failure is recognized; `answerInMeeting` returns an empty string; recording meeting sends = 0; recording IM sends = 0; process pool active = 0. The successful-turn control sends one message to each configured destination, ruling out missing destination configuration.

Source: [Codex terminal-error translation](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/agent/codex/jsonl.ts#L47-L51), [meeting drain and text-only collector](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/meeting/orchestrator.ts#L403-L433), and [empty-answer delivery return](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/meeting/orchestrator.ts#L186-L212). Official Codex defines [failed turns](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec/src/exec_events.rs#L10-L58) and maps them in the [JSONL processor](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L447-L562).

The silent controlled-delivery result is observed; frequency and exact wording of native provider failures are unverified. No raw provider error, credentials or private message content should be copied into a user notice or public evidence.

## Minimal proposed boundary and non-goals

For future shared review only, have the meeting consumer turn a failed terminal outcome into a concise safe notice through its existing caller/broadcast delivery choice. Prefer existing outcome wording/classification. Preserve successful answer behavior and the existing idle-timeout notice; keep raw diagnostics out of user-facing text. Do not add retries or attempt to repair Codex authentication/provider configuration.

Current scope excludes implementation of this shared change, including a Codex-only conditional to bypass that boundary. No product change is included in this audit. Non-goals: upstream failure prevention, security frameworks, new credential storage, environment policy redesign, card APIs, process-tree/JSONL-limit fixes, or general support for other CLIs.

## Acceptance criteria and test seam (future review only)

These criteria describe a possible shared repair; they do not make the ticket implementation-ready.

- [ ] Canonical failed turn with no answer text returns a nonempty generic failure notice through the real meeting caller and controlled Codex adapter/runner.
- [ ] Put `SYNTHETIC_SECRET_SENTINEL_DO_NOT_DISPLAY` in the raw error payload. It appears in neither the returned user-visible result nor any recorded meeting/IM message body. Do not solve this with blanket secret regexes or copy raw error text into the notice.
- [ ] A failed turn after synthetic partial commentary is clearly represented as failed, rather than ending as an ordinary successful answer; its raw error sentinel remains absent.
- [ ] With successful recording destinations, broadcast sends exactly once according to respondIn: meeting = one meeting/zero IM, im = zero meeting/one IM, both = one each. Disabled/unconfigured destinations receive none.
- [ ] Caller-mode returns the safe result with zero direct meeting/IM broadcast sends from the helper, even with both destinations configured. The outer command keeps its existing original-chat reply route; caller does not imply private single-user memory.
- [ ] Successful answers retain their existing once-per-destination behavior. Existing default and configured idle notices/budgets, explicit idle disablement, stop behavior and non-Codex shared behavior are preserved; no duplicate failure/idle notices or active-process residue.
- [ ] Use the same real caller/run-flow/executor/adapter seam with controlled subprocesses and recording delivery, building on existing meeting idle-budget and stopped-final-text tests. Native models and real Feishu delivery remain separate gaps.

Overlap: P09bb addresses the absent-controls idle budget and is already in the frozen code; this probe fails promptly with a terminal event, without an idle timeout. P09ay concerns stopped final-text gating, not ordinary failed turns. P09bc/P09bd do not cover delivery. P09be concerns session continuity and is independently reproducible.

## Scope history

The initial audit at `2d6bfd5` was awaiting review without implementation approval. The latest scope restriction supersedes the intermediate queue approval: because this repair changes shared meeting behavior, implementation is held/excluded from current Codex compatibility work. No product or test-source change is made by this docs correction; the expanded acceptance cases are requirements, not new passing evidence.
