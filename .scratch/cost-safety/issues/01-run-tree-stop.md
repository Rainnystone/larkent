# 01: Run-tree stop (kill the process group/tree, confirm before release)

**What to build:** make every stop path (`/stop`, idle watchdog, `stopAll`, shutdown, the budget from 02) terminate the run's whole process group on POSIX and process tree on Windows, and release the pool slot / active-run record / scope only after the group is confirmed gone. Keep the start-time identity check so a reused PID is never signalled.

**Blocked by:** PR #47 merged

**Priority:** P2 — R6. Descendant survival really happens (bash tool, background script); it costs money only when the descendant calls a model, which is rare. Nothing catches it on POSIX today.

**Status:** parked

## Parent

[docs/specs/cost-safety.md](../../../docs/specs/cost-safety.md) — D1, D8; Findings R6; Notes for implementers (Windows).

## What to build

Today (`99480d2`):

- `runJsonlCli` spawns with `detached: true` (`src/agent/runner/jsonl-cli-runner.ts:83`), so the child already leads its own process group on POSIX.
- `stopChild` (`:196-224`) sends `child.kill('SIGTERM')`, waits `stopGraceMs`, then `child.kill('SIGKILL')`, and only waits for the **direct** child's exit.
- `tests/process/runner-stop-drain.test.ts` (~`:276-288`) asserts the POSIX descendant is **still alive** after stop while `pool.active === 0` and `activeRuns` is empty.

Change:

- POSIX: signal the group (`process.kill(-pid, sig)`) for both SIGTERM and SIGKILL, after checking the leader's start time still matches (`readProcessStartMs`). `ESRCH` on the group = already gone.
- Confirm: after the leader exits, poll the group (`process.kill(-pid, 0)`) within a bounded wait; escalate to SIGKILL on the group if members remain; resolve stop only when the group is empty. On timeout keep the existing `RunCleanupFailed` path and log surviving pids.
- Release ordering: the executor's slot/scope release and `activeRuns` unregister happen after stop resolves (verify they already wait on `finished`; if not, move them).
- Windows: terminate the tree (job object or `taskkill /PID <pid> /T /F`) with the same identity check; confirm the descendant is gone.
- Journal orphan reaping (`src/bot/turn-journal.ts`) uses the same group kill for an orphaned leader whose identity matches.

## Acceptance criteria

- [ ] Red first: flip the existing descendant assertion in `runner-stop-drain.test.ts` to "descendant is dead" on **all** platforms; it fails on POSIX before the change.
- [ ] Fake CLI (scripted/fake-executable) spawns a child that appends to a temp counter file every 50 ms. For each of `execution.stop()`, `activeRuns.interrupt`, `activeRuns.stopAll`, idle-watchdog expiry (fake timers) and shutdown: after stop resolves, the counter does not grow over a further 500 ms.
- [ ] `pool.snapshot().active` drops to 0 and `activeRuns.get(scope)` is cleared only **after** the descendant is gone (assert ordering with a descendant that ignores SIGTERM: slot still held during grace, released after SIGKILL).
- [ ] A descendant that traps SIGTERM is killed by the SIGKILL escalation.
- [ ] Identity: a run whose recorded start time no longer matches the pid is not signalled (fake `readProcessStartMs`); a second unrelated run's process tree survives another run's stop.
- [ ] Green on macOS, Ubuntu and Windows CI (`pnpm ci:local` locally).
- [ ] Delivery note filled; no Spec/scratch on the code PR.

## Out of scope

- Processes that deliberately escape the group (`setsid`, double fork, daemons, remote jobs) — documented as a known limitation.
- Any run budget (02) or queued cancel (06).
- Changing `stopGraceMs` defaults.

## Blocked by

- PR #47 merged
