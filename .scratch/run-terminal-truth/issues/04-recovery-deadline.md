# 04: Awake-time watchdog and non-shortening recovery

**Blocked by:** None · **Status:** partially implemented; remaining work ready-for-agent

Read Spec D5 and the Q1–Q3 decisions dated 2026-11-08. Code PR #70 already contains `6904cee6` and `64acee7e`. Keep both commits; do not reset or rewrite them. They are not completion evidence for this revised ticket: the remaining-time calculation in `64acee7e` still subtracts wall-clock sleep. Finish with additive commits on the code track.

## What remains

Make the watchdog own awake-time silence and remaining budgets. Recovery reads that shared state; it must not reconstruct silence from `Date.now() - lastEventAt` (`src/bot/recovery.ts:27–34,47`). Recovery may only extend a deadline, never shorten it. A recovery floor is not a replacement normal-idle or tool budget.

Use an injectable clock and scheduler to prove the behavior independently of platform timer semantics. A short-tick awake accumulator is one candidate, not proof by itself: define how suspend gaps and clock jumps are excluded. Do not rely on a single long timer or a successful best-effort sleep probe. Check the platform clock assumptions, especially `src/platform/host-sleep.ts:182`: macOS timers may count sleep. Record observed platform evidence separately from deterministic simulated-clock tests; do not claim untested platforms passed.

Route activity accounting through one shared seam used by every watchdog consumer. Include chat, agent-task, and `src/meeting/orchestrator.ts:405–407`, which currently calls `noteDelivered` without `noteRunEvent`. Preserve real progress (including held-back answer deltas) as activity; ticket 07 separates it from heartbeat-only liveness. Model-wait time in a sub-agent uses normal idle, not blanket parent-tool grace (Q3).

## Acceptance
- [ ] Five minutes of awake model silence, 30 minutes suspended, then wake/recovery leaves ten minutes of the default 15-minute awake idle budget. Sleep never consumes idle or tool grace.
- [ ] Recovery never brings an existing deadline forward. Real progress restores normal idle timing; a genuine silent model hang still stops at normal idle.
- [ ] Test both platform clock shapes: a wall jump with a paused timer/clock, and a continuous timer/clock delivering one tick with a 30-minute delta. Check macOS timer behavior explicitly; Windows behavior is unverified until checked, not assumed.
- [ ] An in-flight tool that has used 20 awake minutes retains its remaining 40 awake minutes across suspend (default configuration). Test direct recovery and late `onSuspendAmended` (`src/bot/channel.ts:876–878`). Replace the incorrect 2-/12-minute expectations in `tests/unit/bot/recovery.test.ts:346–388`; neither normal idle nor the 120-second floor replaces tool grace.
- [ ] Disabled idle means no watchdog/recovery deadline: no `120000` fallback from `recovery.ts:32`. Explicit cancellation and terminal events still work.
- [ ] Tool grace is never shorter than configured normal idle: when enabled, the per-tool budget is `max(60 minutes, configured normal idle)`, counted from that tool's start in awake time. With 120-minute normal idle it is 120 minutes, not 60. This floor is the only configuration exception to the nominal 60-minute Q1 cap; events never renew the per-tool start.
- [ ] Chat, agent-task, and meeting tests prove the same activity seam updates watchdog and recovery state once, without filtering away real progress or treating heartbeat-only liveness as progress.
- [ ] Suspend exclusion still works when the sleep probe fails, times out, reports not-suspended, or supplies a late amendment. Probe data may aid logging/backfill, not determine watchdog correctness.
- [ ] Two suspends in one silent run consume neither budget; a previously armed recovery deadline does not prevent correcting the second suspend.
- [ ] Forward and backward wall-clock jumps do not consume or refill awake budgets; negative deltas cannot reduce accumulated awake silence.
- [ ] Record tests and platform evidence in delivery notes; `pnpm ci:local` green. Ticket 07 owns expired/unpaired tool cleanup and heartbeat regressions; do not declare the whole watchdog finished before it passes.
