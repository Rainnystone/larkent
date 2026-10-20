# Task 09bf — Codex meeting terminal failure produces no reply

**Status:** awaiting review — audit finding; implementation is not approved.
**Priority:** proposed P2.
**Responsibility:** bridge bug in meeting terminal-outcome delivery. The upstream failure itself is not a bridge authentication/provider responsibility.
**Blocked by:** review/implementation authorization. No functional dependency on P09be/P09bc/P09bd; coordinate meeting-file ownership with P09be if approved.
**Audit:** [evidence index](../codex-compatibility-audit.md), 2026-10-20.
**Fixed code:** PR52 `feat/bridge-skills` at `8949a2d1c4339a777b1c4ff04af8443d5272e75b`.
**Versions:** larkent package 0.7.0; Node 24.19.0; installed Codex CLI 0.159.2 (help/version only); controlled executable 0.0.0-pin. Official Codex `rust-v0.159.2` source: `ff6aec96948b70d94983af2641a6b67c94faeff5`.
**Pre-publication check:** read the later P09bc code/test change at `2e64fa0a634b8934d2d3dc98a41940149692dd53`. The meeting/adapter paths are unchanged; the portable probe was rerun on a separate export of that head and still reproduces. The frozen audit baseline remains the SHA above.

## Problem and user stories

A participant asks Codex a question during a meeting. Codex ends the turn with a terminal failure before producing answer text, for example after an upstream request failure. The bridge logs that error but sends no answer or failure notice to either configured destination. The participant cannot distinguish failure from an ignored question or a still-running task.

1. As a participant, I want a failed meeting request to finish with a clear failure notice.
2. As a caller using the private meeting command, I want the returned result to explain failure without broadcasting it.

## Observed evidence and inference

Run the [shared sanitized reproduction](P09be-codex-meeting-resume-handle.md#sanitized-reproduction) with mode `failure`. The controlled child emits `thread.started`, then `turn.failed` with `Synthetic upstream failure`, and exits 1. The real Codex adapter, shared runner, executor and meeting consumer are used. This is a normal admitted meeting fixture; delivery uses recording doubles.

Observed twice: terminal failure is recognized; `answerInMeeting` returns an empty string; recording meeting sends = 0; recording IM sends = 0; process pool active = 0. The successful-turn control sends one message to each configured destination, ruling out missing destination configuration.

Source: [Codex terminal-error translation](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/agent/codex/jsonl.ts#L47-L51), [meeting drain and text-only collector](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/meeting/orchestrator.ts#L403-L433), and [empty-answer delivery return](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/meeting/orchestrator.ts#L186-L212). Official Codex defines [failed turns](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec/src/exec_events.rs#L10-L58) and maps them in the [JSONL processor](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L447-L562).

The silent controlled-delivery result is observed; frequency and exact wording of native provider failures are unverified. No raw provider error, credentials or private message content should be copied into a user notice or public evidence.

## Minimal proposed boundary and non-goals

Have the meeting consumer turn a failed terminal outcome into a concise safe notice through its existing caller/broadcast delivery choice. Prefer existing outcome wording/classification. Preserve successful answer behavior and the existing idle-timeout notice; keep raw diagnostics out of user-facing text. Do not add retries or attempt to repair Codex authentication/provider configuration.

No product change is included in this audit. Non-goals: upstream failure prevention, security frameworks, new credential storage, environment policy redesign, card APIs, process-tree/JSONL-limit fixes, or general support for other CLIs.

## Acceptance criteria and test seam

- [ ] Canonical `turn.failed` with no answer text returns a nonempty safe failure notice at the controlled meeting/adapter seam.
- [ ] Broadcast sends that notice once to each configured destination; `deliver: caller` returns it without sending.
- [ ] A terminal failure following partial commentary is represented as failed, rather than presenting the commentary as an ordinary successful answer.
- [ ] Successful answers and existing idle-timeout wording remain correct, with no duplicate notices or active-process residue.
- [ ] Tests exercise the actual meeting caller and canonical Codex events. Native model execution and real Feishu delivery remain separately labeled gaps until directly verified.

Overlap: P09bb addresses the absent-controls idle budget and is already in the frozen code; this probe fails promptly with a terminal event, without an idle timeout. P09ay concerns stopped final-text gating, not ordinary failed turns. P09bc/P09bd do not cover delivery. P09be concerns session continuity and is independently reproducible.
