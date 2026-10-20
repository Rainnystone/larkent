# Codex compatibility audit — 2026-10-20

**Status:** bounded audit complete; findings await review. No implementation approval, product changes, deployment, new PR or merge.

## Frozen scope and sources

- Repository: `Rainnystone/larkent`; code PR52 `feat/bridge-skills`, fixed at `8949a2d1c4339a777b1c4ff04af8443d5272e75b`; docs PR51 `docs/bridge-skills`, starting at `993f134861386e0977f761169ab27d93935d3e39`.
- Execution: disposable Linux Cloud session; Node 24.19.0, installed Vitest 2.1.9. Codex CLI 0.159.2 was used only for `--version` and help. No native model was invoked.
- Official Codex [0.159.2 source](https://github.com/openai/codex/tree/ff6aec96948b70d94983af2641a6b67c94faeff5): `ff6aec96948b70d94983af2641a6b67c94faeff5`. The relevant exec CLI/schema/JSONL-processor files were byte-identical to 0.158.0 at `064c6b8c737f5b41d171fdda80bd9ef10ad06eb3`; this is a bounded comparison, not a version-support promise.
- Read and executed Matt [research](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/research/SKILL.md), [diagnosing-bugs](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/diagnosing-bugs/SKILL.md), [to-spec](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/to-spec/SKILL.md), [to-tickets](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/to-tickets/SKILL.md) and [code-review](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/code-review/SKILL.md) at `49dd158d1076134a641b33efb035946536778336`. Applied discovery → bounded problem/test-seam specification → independent, verifiable tickets → separate Standards/Spec review. Audit authorization sets the existing docs tracker and review-only status; no ready-for-agent label or implementation workflow is implied.

The bridge owns launch arguments/stdin/cwd/environment handoff, event interpretation, lifecycle/session routing and delivery. Codex owns account/API authentication, providers and its security framework. Testing seams are the existing adapter/runner, meeting caller, session catalog and recording channel; controlled processes replace the model CLI. No new product seam is proposed.

## Review queue

| Ticket | Reproduced behavior | Classification | Review boundary |
| --- | --- | --- | --- |
| [P09be](tickets/P09be-codex-meeting-resume-handle.md) | Same-meeting follow-up omits the first Codex handle despite unchanged policy; catalog control restores resume | Bridge bug, proposed P2 | Existing meeting session-recording contract |
| [P09bf](tickets/P09bf-codex-meeting-failure-notice.md) | Canonical failed turn yields empty answer and zero recording-destination sends | Bridge bug, proposed P2 | Existing meeting terminal-outcome notice/delivery |

Both probes ran twice and assert the missing user behavior, so they exit 1 on the frozen snapshot. A successful-turn control and the catalog-seeding control pass. The portable synthetic reproduction is embedded in P09be; no raw logs or authenticated outputs are attached. User consequence beyond adapter input and recording destinations is explicitly inferred, not native/live evidence.

## Evidence and coverage

Classes: **D** = installed CLI diagnostic; **S** = pinned source; **U** = existing unit/integration tests; **C** = real bridge with controlled CLI process/recording delivery; **R** = synthetic event replay. None is native model or live Feishu E2E.

| Scenario | Evidence and observed result | Limit |
| --- | --- | --- |
| Fresh/resume launch, stdin, cwd, selected model, images | D/S/U/C: 27 adapter/history checks, controlled Codex process row; six help-only fresh/resume/image forms return help successfully | Help does not prove model selection or native permission/config behavior |
| Chat identity and isolation | U/C: existing resume/catalog/IM tests, plus Codex shared-contract new/resumed IM and automatic-run isolation | Native Codex memory/history is unverified |
| Meeting continuity | C: P09be fails; handle observed, same fingerprint, empty catalog; catalog control passes | Model-independent bridge failure |
| Shell tool output and final reply | U/C: command/nonzero-exit translation, last-message buffering, Codex card-parity row pass | Other native item kinds remain verification questions below |
| Failures/exit codes and delivery | U/C: runner spawn/nonzero/EOF/retryable-error checks and Codex card error surface pass; meeting failed-turn notice fails as P09bf | Native provider failures not induced |
| Timeout, user stop, forbidden-stop final-text gating | U/C: selected runner timeout/abort/settlement cases, existing stop-delivery callers and meeting idle-budget tests pass | Existing meeting idle test uses a controlled shared-runner fixture; not native Codex |
| Automation/plugin tool contract and cards | C: Codex row of shared contract passes new/resumed IM, automatic runs, tool feedback, card confirmation and stop | Controlled executable chooses tools; no native model-tool selection claim |
| Duplicate/reordered/future events | U/R: duplicate answer shapes produce one final answer; repeated/late terminal input produces one terminal; completion-before-start retains failed result and increments anomaly; future event increments unknown counter | Reordered start can remain a trailing open tool; no native producer evidence, no required fix |
| Process cleanup | U/C: selected stop/settlement checks and both meeting probes return pool to zero | Stronger descendant/SIGKILL guarantee already belongs to P09bc; Windows/macOS untested here |
| Plausible protocol/version variation | S/U/R: current completed-message protocol matches buffering; legacy message shape and retryable error compatibility pass | Only the pinned nearby versions/files compared |

Existing selected tests: **171 passed**, including shared-path checks; no full-suite or full-native claim. Commands below all use `--maxWorkers=1 --minWorkers=1`:

```sh
node node_modules/vitest/vitest.mjs run tests/unit/agent/codex-argv.test.ts tests/unit/agent/codex-jsonl.test.ts tests/unit/agent/codex-prepare-run.test.ts tests/unit/agent/codex-history.test.ts --maxWorkers=1 --minWorkers=1
node node_modules/vitest/vitest.mjs run tests/process/jsonl-cli-runner.test.ts -t 'CodexAdapter|runner settlement boundaries|runJsonlCli|wrapParsedTranslator' --maxWorkers=1 --minWorkers=1
node node_modules/vitest/vitest.mjs run tests/process/agent-spawn-env.test.ts -t codex --maxWorkers=1 --minWorkers=1
node node_modules/vitest/vitest.mjs run tests/process/six-cli-bridge-contract.test.ts -t codex --maxWorkers=1 --minWorkers=1
node node_modules/vitest/vitest.mjs run tests/integration/session/resume.test.ts tests/integration/session/catalog-v1-resume.test.ts tests/integration/bot/im-run-flow.test.ts tests/integration/bot/stopped-final-text.test.ts tests/integration/meeting/idle-budget.test.ts tests/unit/automations/agent-run.test.ts tests/unit/bot/run-outcome.test.ts --maxWorkers=1 --minWorkers=1
node node_modules/vitest/vitest.mjs run tests/integration/bot/feishu-parity.test.ts -t codex --maxWorkers=1 --minWorkers=1
```

Counts in command order: 27, 48, 1, 1, 93, 1. The environment test was run with the same `-t codex` filter in the initial shared-contract invocation. pnpm's initial launcher could not initialize its read-only home, so installed executables were invoked directly. The first shared-contract setup lacked generated console HTML; building it with the existing Vite command in a disposable export of the fixed snapshot allowed the rerun to pass. No tracked product/test source was changed.

## Verification questions, not implementation tickets

1. **Failed/declined command without an exit code:** canonical schema and [mapper](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L162-L180) preserve status. Replaying `status: failed, exit_code: null` produces `isError: false`. The producer's known approval/guardian completions can use null exits, but reachability under the bridge's `approval_policy=never` was not proved. Require reachable native/source evidence before requiring a fix; no approval-system redesign.
2. **Non-shell native items:** MCP, file-change, reasoning, search and todo items exist in the [official schema](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec/src/exec_events.rs#L104-L166). The adapter currently interprets command executions and agent messages. Establish the concrete promised progress/idle behavior for these items before expanding event handling. No blanket protocol framework is proposed.
3. **Arbitrary event reordering:** the synthetic replay exposes incomplete-tool presentation for completion-before-start. Native stdout preserves byte order and no native source trace showed this item order; the audit does not require speculative reorder recovery.

## Known work, gaps and publication gate

- P09ay/P09az/P09bb are resolved in the frozen code and have existing targeted coverage. P09bc has a later implementation at `2e64fa0a634b8934d2d3dc98a41940149692dd53`; its full four-file process-tree/test diff was read, but its acceptance is not claimed here. P09bd remains separately owned work. No duplicate ticket or implementation was created; the byte-limit and descendant-kill cases are excluded from this audit's findings.
- This session found no `lark`/`lark-cli` executable on PATH and verified no dedicated authorized live destination/harness. No live chat/meeting/card writes, restarts or deployments occurred. Earlier authenticated bot-read observations are not this session's evidence. Direct Cloud-tool success would bypass the CLI adapter and would not establish its E2E compatibility.
- Optional `tests/process/codex-real.smoke.test.ts` was read but not enabled. Native model execution, tool selection, conversation memory, stop/resume, image interpretation and real Feishu delivery remain explicit gaps. No credential copy/login/auth-store change or repeated nested-model attempt was made. These gaps do not require the user's Mac for this audit.
- Independent review dispositions: Standards — 0 findings. Spec — 1 fixture correction (required canonical usage fields), corrected and independently rerun; 0 remaining findings. Both axes checked scope, privacy, evidence and overengineering. This reviews the audit deliverables; both tickets still await maintainer review and implementation authorization.
- Pre-publication reconciliation: code advanced to `2e64fa0a634b8934d2d3dc98a41940149692dd53` (P09bc); docs base remains `993f134861386e0977f761169ab27d93935d3e39`. Read the complete later product/test diff. Meeting/adapter paths are unchanged, and rerunning both portable probes plus the catalog control on a separate export of that head preserves both findings. Neither is resolved/superseded. The audit baseline and 171-check evidence remain frozen at `8949a2d`; these later-head probes are additional evidence.
- Publication is limited to these two sanitized tickets and this index on PR51. Only synthetic fixtures/minimal summaries are included. Commit author/committer must be `Codex <codex@openai.com>`, with no personal coauthor metadata. Maintainer review owns prioritization and any later implementation approval.
