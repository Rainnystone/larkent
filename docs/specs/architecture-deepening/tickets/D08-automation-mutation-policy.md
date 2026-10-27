# D08 Automation mutation policy in one module

Spec: D3, A8. Blocked by: D07.
Touch: `src/automations/task-mutation.ts`, `manage-operation.ts`, `command.ts` (~1202-1214 `mutateAuto`), `src/card/dispatcher.ts` (~531-569 board actions), `src/automations/scheduler.ts` (~224-257 `guard.operation`), `src/automations/tools.ts`, `src/automations/store.ts` (`list` / `listCommitted` call sites), tests, `CONTEXT.md`.

## Why

Pause / resume / delete / replace exist on three paths with the policy embedded per caller: slash command and board apply immediately; the bridge tool goes through a confirmation draft. Revision guards are invoked in four places. `scheduler.resume` carries tool-path operation semantics. Callers choose `list()` vs `listCommitted()` by convention.

## Do

1. Red: policy tests: actor `human` (slash, board) applies immediately; actor `model` (tool) creates a confirmation draft via D07; stale revision, missing task, not permitted and no remaining fires give today's errors; the tool's operation id dedupe and receipts still hold.
2. Green: one mutation module takes the operation, the target and the actor, and either applies or submits for confirmation. Revision guards live there only. The scheduler exposes raw timing operations; the "no remaining fires on tool resume" rule moves out of `scheduler.ts`.
3. Make committed vs live reads explicit at the module interface so receipts always read committed state; remove convention-only call-site choices where this module now owns the read.
4. Keep green: `tests/integration/bot/reminder-tools/*.test.ts`, `auto-board-card.test.ts`, `tests/unit/automations/scheduler.test.ts`, `store.test.ts`, task mutation and manage operation tests.
5. Update `CONTEXT.md` (mutation policy by actor). `/code-review`.

## Acceptance

- [ ] The D3 policy is stated in one module; slash, board and tool paths call it.
- [ ] `scheduler.ts` has no operation / tool semantics.
- [ ] Tests in Do 4 green; `pnpm ci:local` green; delivery note posted.
