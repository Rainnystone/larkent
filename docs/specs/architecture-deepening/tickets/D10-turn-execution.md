# D10 Turn execution module

Spec: D14, A11, D13. Blocked by: D01, D02, D04, D05.
Touch: `src/bot/channel.ts` (`runAgentBatch` ~1706-2416, `processAgentStream`, `createLazyProgressStream`, `awaitRenderAwareStream`, `finalReplyState`, reaction cleanup), `src/automations/agent-run.ts` (~490-560 event loop, ~370-395 body), `src/bot/cot.ts` (stream wiring only), `src/bot/run-flow.ts`, new module (e.g. `src/bot/turn.ts` or `src/runtime/turn.ts`), tests, `CONTEXT.md`.

## Why

The agent run loop exists twice: `agent-run.ts:490-550` re-implements `processAgentStream` (system → watchdog, `shouldDeliverAgentEvent`, `noteDelivered`, terminal tracking, `reduce`, outcome) and then `finalReplyFor` + `renderText`. The copies have drifted (the fire derives its outcome without outage overlap). `runAgentBatch` interleaves chat-specific input preparation with this shared execution and delivery. Two callers make the seam real.

## Do

1. Re-read the code after D01 / D02 / D04 / D05 have merged; the module's interface comes from what those tickets left in `runAgentBatch` and `agent-run.ts`, not from this ticket's line numbers.
2. Characterize first and keep green: `tests/integration/bot/stream-delivery.test.ts`, `im-run-flow.test.ts`, `attachment-run-flow.test.ts`, `topic-quote.test.ts`, `idle-lifecycle.test.ts`, `stopped-final-text.test.ts`, `markdown-stream-startup-failure.test.ts`, `progress-card-patch-failure.test.ts`, `run-observability.test.ts`, `auto-agent-task-run.test.ts`, `auto-profile-identity.test.ts`, `tests/unit/automations/agent-run.test.ts`, `tests/unit/bot/cot.test.ts`, the seven-CLI bridge contract tests.
3. Red: module tests with a scripted adapter replaying D03 transcripts, a real executor, a real Outbox and a recording channel, per reply mode (card, markdown, text, CoT): one visible answer; progress stream opens lazily and is recalled when empty; stop, idle timeout, error and outage overlap give the same terminal state and notice as today; a policy-guard hook stops the run on a matching `tool_use` (automation caller); the automation caller's outcome now includes outage overlap (D13 regression test).
4. Green: one module that runs a turn from run options plus a delivery target to a delivered final state. Chat batches keep media, quotes, topic context, resume / continuation and prompt building; automation fires keep task text, a fresh session and the policy-guard hook. Delete the event loop and body rendering from `agent-run.ts`.
5. Replace, don't layer: delete `startChannel`-level tests that only pinned moved internals. Update `CONTEXT.md` (new term: turn execution; how run, settlement and Outbox relate). `/code-review`.

## Acceptance

- [ ] No agent event loop remains in `src/automations/`; chat and automation fires call the same module.
- [ ] `runAgentBatch` contains only chat-specific input preparation and one call into the module.
- [ ] Automation fire outcomes include outage overlap (regression test).
- [ ] Tests in Do 2 green; `pnpm ci:local` green; delivery note posted.
