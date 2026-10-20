# Shared meeting findings observed through Codex — P09be/P09bf

**Current status: held.** Both findings concern shared meeting behavior. The latest scope restriction excludes their implementation from the Codex-specific compatibility work. This document completes Matt specification/ticket records; it authorizes no product change, test-source change, worker dispatch or Codex-only workaround.

**Scheduling history:** P09bc → P09bd → P09be → P09bf was the proposed sequential writer queue, not functional dependencies. The later shared-behavior restriction supersedes readiness/dispatch for P09be/P09bf. Neither has a current implementation slot; existing P09bc/P09bd coordination remains outside this docs task.

## Problem Statement

Controlled Codex runs expose two shared-consumer omissions: meeting system events do not persist their conversation handle, and failed meeting turns can return no user-visible failure notice. The first loses resumable context; the second makes failure look like an ignored or unfinished request. Codex is the reproduction path, not evidence of Codex-specific ownership. The [frozen audit](codex-compatibility-audit.md) does not establish native-model or live-Feishu acceptance.

The prototype’s actual implementation uses one conversation per meeting. Caller and broadcast select where an answer is delivered after the same run; caller is not an actor/memory isolation key or a guarantee of a private single-user destination. Missing persistence is inherited from that implementation, not evidence of an intentional isolation mechanism.

## Solution

For future shared-behavior review only: P09be would restore session-event persistence under the existing per-meeting scope and normal agent/cwd/policy identity. P09bf would return a safe terminal-failure result through the existing caller/broadcast output route. The owner confirmed preservation of the upstream meeting scope, then separately restricted shared changes; that restriction holds both repairs. No new isolation policy or adapter-specific conditional is proposed.

## User Stories

1. As a meeting participant, I want an authorized follow-up in the same meeting to resume the earlier conversation, so that prior work remains available.
2. As a participant in a different meeting, I want separate context, so that another meeting’s history is not reused.
3. As a user who changes the working directory, I want incompatible handles rejected, so that work does not resume in the wrong workspace.
4. As a user whose effective policy changes, I want incompatible handles rejected, so that previous access assumptions are not reused.
5. As a caller using a meeting command, I want its answer returned through the existing command route while retaining the shared meeting conversation, so that changing delivery mode does not silently reset context.
6. As a participant whose request fails, I want a clear failure notice, so that I can distinguish failure from an ignored or running request.
7. As a participant who saw partial commentary, I want the final result to acknowledge failure, so that incomplete commentary is not presented as a completed answer.
8. As a user receiving a failure notice, I want raw error details excluded, so that error handling does not disclose sensitive payloads.
9. As a caller, I want the meeting helper to return its result without broadcasting it, so that the command can reply to its original requesting chat.
10. As a participant using broadcast delivery, I want exactly one result per configured destination, so that the bridge does not duplicate its final reply.
11. As an existing meeting user, I want successful answers, idle notices and non-Codex shared behavior preserved, so that future repairs do not change unrelated runs.

## Implementation Decisions

- These are two independently verifiable shared-behavior slices, retained as findings rather than dispatchable Codex repair tickets. No product implementation is authorized here.
- The reference scope is one conversation per meeting, with existing profile/agent/cwd/policy checks. Actor/delivery isolation, global fingerprint/schema changes and new session abstractions are outside this repair description.
- Caller output remains returned to its caller. The surrounding command may reply in the original chat, including a group; the meeting helper itself must not broadcast the caller-mode answer.
- A future terminal-failure repair should prefer existing generic outcome wording and routing, without raw-error copying, blanket secret regexes, new retries or a security framework.
- Do not add a Codex-only branch to make a shared feature change appear adapter-specific. Any future implementation requires separate approval for the shared meeting behavior.

## Testing Decisions

- Future review seam: the real meeting caller through run flow, executor, adapter and runner, with a controlled CLI subprocess and recording destinations. Assert adapter inputs and user-visible results rather than catalog-helper internals. Native credentials/models/live writes are unnecessary for these regressions.
- Prior art: existing session-resume/catalog integration tests, meeting idle-budget tests and stopped-final-text caller tests. The [historical runnable reproduction](evidence/codex-meeting-reproduction.md) remains separate evidence, not a full program inside either ticket.
- P09be review criteria are distinct: same-meeting resume; different meeting with cwd/policy unchanged; cwd mismatch within the same meeting; policy mismatch with meeting/cwd unchanged. Include caller→broadcast resume under the existing shared scope and unchanged policy, while caller-mode itself makes zero direct meeting/IM broadcast sends. Preserve non-Codex shared resume/stop/delivery behavior; no new actor/delivery key.
- P09bf review criteria include no-answer failure, partial-commentary failure, raw error containing `SYNTHETIC_SECRET_SENTINEL_DO_NOT_DISPLAY`, exact-once successful broadcast sends for meeting/IM/both, caller-helper zero sends, successful answers and unchanged default/configured/disabled idle behavior. The sentinel must be absent from the returned user-visible result and every recorded destination body. The outer command’s existing reply route is preserved.
- These are future acceptance requirements, not newly executed or passing tests. The original 171 checks remain historical evidence. This docs correction adds/changes no product or test-source files. If separately approved later, run only affected tests with `--maxWorkers=1 --minWorkers=1`.

## Out of Scope

Implementation of either shared meeting finding in the current Codex compatibility work; artificial Codex-only guards; actor/delivery memory isolation; Codex account/API authentication or provider changes; credentials, security frameworks, environment allowlists, speculative protocol handling, transcript redesign, new card APIs, other CLI audits, deployment, merge, or reimplementation of separately owned P09bc/P09bd work.

## Further Notes

**Upstream source checked:** `zarazhangrui/lark-coding-agent-bridge`, fixed at `589868119ce9a0a860aaf4936b5f9bac14e72681`. Its [meeting scope and routing](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/589868119ce9a0a860aaf4936b5f9bac14e72681/src/meeting/orchestrator.ts#L39-L179) share one scope before output selection; [ended-summary routing](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/589868119ce9a0a860aaf4936b5f9bac14e72681/src/meeting/orchestrator.ts#L240-L254) also uses caller before sending elsewhere. The [meeting drain](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/589868119ce9a0a860aaf4936b5f9bac14e72681/src/meeting/orchestrator.ts#L290-L356) omits session recording, while [normal IM](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/589868119ce9a0a860aaf4936b5f9bac14e72681/src/bot/channel.ts#L1003-L1011) records it. [Meeting commands](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/589868119ce9a0a860aaf4936b5f9bac14e72681/src/commands/index.ts#L2185-L2225) return caller-mode answers using the [original chat reply route](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/589868119ce9a0a860aaf4936b5f9bac14e72681/src/commands/index.ts#L280-L303).

The upstream [catalog identity](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/589868119ce9a0a860aaf4936b5f9bac14e72681/src/session/catalog.ts#L50-L56) and [resource fingerprint inputs](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/589868119ce9a0a860aaf4936b5f9bac14e72681/src/policy/fingerprint.ts#L56-L63) omit actor/delivery. The fork at `2e64fa0a634b8934d2d3dc98a41940149692dd53` retains the corresponding [meeting scope/routing](https://github.com/Rainnystone/larkent/blob/2e64fa0a634b8934d2d3dc98a41940149692dd53/src/meeting/orchestrator.ts#L40-L212) and [resume identity](https://github.com/Rainnystone/larkent/blob/2e64fa0a634b8934d2d3dc98a41940149692dd53/src/bot/run-flow.ts#L109-L123). Caller→broadcast context reuse after restoring persistence is a static-derived consequence. Neither upstream source nor this audit proves working native shared memory, private-content disclosure, or explicit consent to disclose private content.

**Scope history:** `2d6bfd5c2f356556e893494e84fbcc3b0ebba05a` published review-only findings. A later implementation queue was discussed; the memory choice was resolved in favor of existing upstream semantics. The latest restriction then held both findings because their repair changes shared meeting behavior. That hold is current; there is no pending isolation decision and no implementation-ready label.

The existing PR51 files remain the configured tracker. This concise specification follows the actual to-spec/to-tickets contents at Matt revision `49dd158d1076134a641b33efb035946536778336`; latest user scope overrides the workflow’s default ready-for-agent status. No additional architecture phase is introduced.
