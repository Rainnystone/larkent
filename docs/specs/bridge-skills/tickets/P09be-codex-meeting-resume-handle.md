# Task 09be — Codex meeting follow-up loses its thread handle

**Status:** held — shared meeting finding, excluded from the current Codex-specific compatibility implementation. Not dispatchable.
**What to build (future shared review only):** restore missing session-event persistence under the existing per-meeting scope; no product repair is currently authorized.
**Specification:** [P09be/P09bf follow-ups](../codex-meeting-followups.md).
**Scheduling:** no current implementation slot. The earlier P09bc → P09bd → P09be → P09bf queue is historical and was scheduling, not functional dependencies.
**Priority:** proposed P2.
**Responsibility:** shared meeting-consumer omission inherited from the prototype, reproduced through Codex. This is not a Codex-adapter-specific defect or an upstream authentication/provider issue.
**Blocked by:** explicit future authorization for shared meeting changes. No functional ticket dependency on P09bc, P09bd or P09bf. The memory choice is resolved in favor of existing upstream scope; that does not override the later implementation hold.
**Audit:** [evidence index](../codex-compatibility-audit.md), 2026-10-20.
**Fixed code:** PR52 `feat/bridge-skills` at `8949a2d1c4339a777b1c4ff04af8443d5272e75b`.
**Versions:** larkent package 0.7.0; Node 24.19.0; installed Codex CLI 0.159.2 (help/version only); controlled executable 0.0.0-pin. Official Codex `rust-v0.159.2` source: `ff6aec96948b70d94983af2641a6b67c94faeff5`.
**Pre-publication check:** read the later P09bc code/test change at `2e64fa0a634b8934d2d3dc98a41940149692dd53`. The meeting/adapter paths are unchanged; the portable probe was rerun on a separate export of that head and still reproduces. The frozen audit baseline remains the SHA above.

## Problem and user stories

A participant asks Codex to remember a synthetic decision, then asks a follow-up in the same per-meeting conversation. The bridge launches another fresh Codex turn without the first thread's resume handle. A follow-up that relies on the prior answer or tool work can lose that context. Recent meeting transcript context is separate from the missing Codex conversation.

1. As a meeting participant, I want a same-meeting follow-up to resume the existing conversation, so that prior work remains available.
2. As a participant in another meeting, I want separate context, so that another meeting’s history is not reused.
3. As a caller using a meeting command, I want the shared meeting conversation preserved while its answer uses the command route, so that delivery mode does not silently reset context.

## Observed evidence and inference

The reproduction uses real `answerInMeeting → startRunFlow → RunExecutor → CodexAdapter → runJsonlCli` and a controlled subprocess emitting canonical Codex JSONL. Only external Codex execution and Feishu delivery are controlled; no model or live service is called. The historical resume probe is broadcast → caller-only; it demonstrates missing recording under the current identity, not proof of native memory or private-content disclosure. The existing shared scope is source-grounded; caller is an output route, not a privacy isolation key.

Observed twice: the adapter emits `system.resumeHandle`, the first answer reaches both recording destinations, the catalog has zero entries, both submissions use the same policy fingerprint, and the second adapter input has no `resumeHandle`. The process pool returns to zero active processes. Seeding the catalog with the first handle and the observed identity makes the second input carry it. This control changes fixture state only, not product code.

Minimal synthetic result: `systemHandleObserved=true; entriesAfterFirst=0; samePolicy=true; secondHasResumeHandle=false`. With the catalog control, only the final field becomes `true`.

Source: the [meeting drain](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/meeting/orchestrator.ts#L394-L423) collects text but never records system handles. The existing [recording seam](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/bot/run-flow.ts#L240-L258) owns that catalog update, and [resume lookup](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/bot/run-flow.ts#L109-L123) uses the catalog for Codex. The production channel supplies the catalog to meeting consumers. Official [thread event schema](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec/src/exec_events.rs#L10-L52) defines the handle-bearing event.

Inferred user consequence: native conversational memory will be unavailable through resume when the handle is omitted. Actual native memory loss was not tested.

## Minimal proposed boundary and non-goals

For future shared review only, restore session-event recording using the existing per-meeting scope and agent/cwd/policy lookup. Preserve caller-mode output routing and existing non-Codex behavior. Do not add actor/delivery isolation, a new session database, a routing framework, a global fingerprint redesign or a Codex-only conditional. Current scope excludes implementing this shared repair.

No product change is included in this audit. Non-goals: Codex login/API adapters, provider behavior, new environment filtering, other CLI audits, meeting transcript redesign, process-tree or JSONL-size fixes.

## Acceptance criteria and test seam (future review only)

These criteria describe a possible shared repair; they do not make the ticket implementation-ready.

- [ ] Positive case: two successful questions in one meeting with matching agent/cwd/policy pass the first handle into the second run.
- [ ] Caller→broadcast case: a caller-mode question followed by broadcast in the same meeting and unchanged identity resumes the shared handle. Caller-mode itself returns its answer with zero direct meeting/IM broadcast sends; the outer command keeps its original-chat reply route.
- [ ] Different-meeting case: change only meeting identity while cwd and effective policy match; the earlier handle is not reused.
- [ ] Cwd-mismatch case: keep meeting and other policy inputs fixed, change resolved cwd; the incompatible handle is not reused.
- [ ] Policy-mismatch case: keep meeting/cwd fixed, change an effective policy input; the incompatible handle is not reused.
- [ ] Preserve non-Codex shared meeting resume/stop/delivery behavior using existing controlled caller coverage. No new actor/delivery key or artificial adapter-specific guard.
- [ ] Normal answers reach configured destinations once; process/pool cleanup remains complete.
- [ ] Exercise the real meeting caller through run flow/executor/adapter with controlled subprocesses and recording destinations, not only the catalog helper. Native memory and real delivery remain separately labeled gaps.

Overlap: P09ay/P09az/P09bb are already represented by the frozen code; P09bc/P09bd cover process cleanup and JSONL limits. None covers this missing recording call. P09bf shares the consumer but concerns terminal failure delivery and can be reviewed independently.

## Evidence and scope history

[Sanitized runnable evidence](../evidence/codex-meeting-reproduction.md) is separate from this ticket. On the frozen snapshots, the resume probe exits 1 with an observed handle, empty catalog and missing second handle; catalog-seeding exits 0. This is controlled routing evidence, not native shared-memory or disclosure proof.

The [specification’s upstream evidence](../codex-meeting-followups.md#further-notes) pins the prototype implementation at `589868119ce9a0a860aaf4936b5f9bac14e72681`: one conversation per meeting, output routing after the same run, missing meeting event persistence despite normal IM recording. The omission does not establish intentional privacy isolation. Caller→broadcast context reuse after persistence is a source-derived consequence, not observed private-content leakage.

Initial audit `2d6bfd5` was review-only. The owner later confirmed preserving upstream scope, but the latest restriction excludes shared meeting changes from current Codex compatibility repairs. Both this finding and P09bf are therefore held; no pending memory-policy choice or implementation-ready authorization is implied. This docs correction changes no product/test source.
