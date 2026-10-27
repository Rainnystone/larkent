# D05 Run outcome derived once

Spec: D9, A5. Blocked by: D01, D04.
Touch: `src/runtime/run-executor.ts`, `src/bot/run-outcome.ts`, `src/bot/channel.ts` (`processAgentStream` early / final outcome ~3152-3219), `src/automations/agent-run.ts` (~535), `src/bot/active-runs.ts`, tests, `CONTEXT.md`.

## Why

`deriveRunOutcome` runs at `run-executor.ts:347` (for `run.failed` logs, without outage overlap), `channel.ts:3163` (early, on `error`) and `3194` (final, assigns `handle.outcome`), and `automations/agent-run.ts:535`. CONTEXT.md calls the outcome unique.

## Do

1. Red: executor-level tests that a settled run exposes exactly one `handle.outcome` covering stop reason, exit / signal, terminal event, stderr snapshot, CLI signatures and outage overlap (overlap read through an injected getter at settlement, plus "started while down").
2. Green: derive once in the executor at settlement; `run.failed` logging, card terminal, notices, channel and automation fires read `handle.outcome`. If the channel needs an early classification for display before settlement, it reads a provisional value from the executor rather than deriving its own.
3. Characterize first and keep green: `tests/integration/bot/terminal-error-classification.test.ts`, `devin-stop-reasons.test.ts`, `stopped-final-text.test.ts`, `stall-after-recovery.test.ts`, `idle-lifecycle.test.ts`, `auto-agent-task-run.test.ts`, `outage-overlap-outcome.test.ts`, `run-outcome-stream.test.ts`, `tests/unit/bot/run-outcome.test.ts`.
4. Update `CONTEXT.md` › run outcome to name the owner. `/code-review`.

## Acceptance

- [ ] Exactly one production call site of `deriveRunOutcome`.
- [ ] Tests in Do 3 green; `pnpm ci:local` green; delivery note posted.
