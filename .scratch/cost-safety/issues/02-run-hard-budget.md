# 02: Absolute run budget in `RunExecutor` for every entry point

**What to build:** a wall-time budget and a step budget enforced by the shared `RunExecutor`, independent of the idle watchdog, so every run — IM, comment, meeting, `/doctor`, card-dispatched — stops when either limit is hit, whatever events it keeps emitting.

**Blocked by:** PR #47 merged

**Priority:** P2 — R5. Only triggers when an agent keeps emitting events while flailing; the bridge does not cause that, so it is rare. But it is the only bound on what one task can cost; today idle re-arms on every event, tool calls pause it up to 60 min, comments have no default and `/doctor` has none.

**Status:** parked

## Parent

[docs/specs/cost-safety.md](../../../docs/specs/cost-safety.md) — D2, D8; Findings R5; Notes for implementers (counting).

## What to build

Today (`99480d2`):

- `RunExecutor.submit` (`src/runtime/run-executor.ts:84-175`) spawns and returns an execution; it enforces no deadline.
- IM idle watchdog lives in `channel.ts` (`:2643-2681`), re-arms on every event, 60 min cap while a tool is open. Comments use their own optional deadline (`comments.ts:759-769`). `/doctor` (`commands/index.ts:1127-1210`) and meetings (`meeting/orchestrator.ts`) loop over `execution.subscribe()` with no bound.

Change:

- Config next to `getRunIdleTimeoutMs` in `src/config/schema.ts`: `runMaxWallMinutes` (proposed default 120, clamp 1–720) and `runMaxSteps` (proposed default 400, clamp 10–5000); `0` disables each. Exact defaults are confirmed by the owner on un-park.
- `SubmitRunInput` takes an optional budget override; `/doctor` passes a fixed tighter wall budget (proposed 5 min). No other entry point passes one.
- In the executor: arm a wall deadline at spawn; count `tool_use` events from the run's own event stream (not `usage`, not Feishu output). On either limit, stop through the normal stop path with stop request `{ type: 'run-budget', limit: 'wall' | 'steps' }` (new variant in `src/bot/run-outcome.ts`) and log `run-budget-exceeded` (`runId`, `scope`, `source`, `limit`, elapsed, steps).
- IM, comment, meeting and `/doctor` surface the stop as a normal terminal outcome with one notice naming the budget (IM via the existing notice path; comment via its reply path; `/doctor` via its report card; meeting via its reply).
- No event, tool call or recovery stall extends the budget. A human 继续 starts a new run and so a new budget.

## Acceptance criteria

- [ ] Red first: a fake agent emitting a `text` event every 30 s (fake timers) forever, through IM with idle 15 min, is never stopped on the merged #47 tree.
- [ ] Wall: same fake agent stops at `runMaxWallMinutes`; stop reason `run-budget`/`wall`; the slot is freed.
- [ ] Wall with an open tool call: `tool_use` with no `tool_result` and periodic events still stops at the wall budget (the 60 min tool pause does not extend it).
- [ ] Steps: a fake agent emitting `tool_use`/`tool_result` pairs in a loop stops after `runMaxSteps` tool_use events; `usage` events do not count.
- [ ] Same wall case through the comment entry point, the meeting entry point (meetings enabled in the test profile) and `/doctor` (5 min budget) — one test per entry point, all through real entry code with fake agent.
- [ ] `0` disables each budget; out-of-range values clamp; unset uses the defaults.
- [ ] A run that finishes before the budget is unaffected (no notice, no stop).
- [ ] `pnpm ci:local` green; delivery note filled; no Spec/scratch on the code PR.

## Out of scope

- Token or money budgets, per-user/day quotas, spawn-rate limits.
- Budget renewal UI.
- Comment default idle (03); queued cancel (06); process-group kill (01; budget stop just uses the stop path).

## Blocked by

- PR #47 merged
