# Delivery note: 2: RunOutcome 模型与 stop reason 枚举

**Status:** delivered (deterministic layer)

- Code PR: [#39](https://github.com/Rainnystone/larkent/pull/39)
- SHA: `a0849064ef07475607abbe15844d0a28f09ccd28` (`feat/run-reliability`)
- Evidence:
  - TDD red: `deriveRunOutcome` stub returned `failed(unclassified)` (table-driven cases red); `interrupt`/`stopAll` required `StopRequest` at every call site; runner-timeout card still shared idle-watchdog copy.
  - TDD green: `src/bot/run-outcome.ts` (`requestStop` first-writer, `deriveRunOutcome`, `noteTerminalStop`, `shouldDeliverAgentEvent`); call-site reasons in commands/channel/meeting/executor; `reliability.runOutcome` default on; card `runner_timeout` vs idle watchdog; spawn stays in the bridge process group. Tests: `tests/unit/bot/run-outcome.test.ts`, `tests/unit/commands/stop-request.test.ts`, `tests/static/run-outcome-*.test.ts`, `tests/integration/bot/run-outcome-stream.test.ts`.
  - `pnpm ci:local`: green on `a084906` (typecheck + full vitest + build).
  - test bridge: not required for this model ticket. Live `e2e:up` was **not** run (no isolated tester credentials; live data root not touched). No ids or tokens recorded.
- Residual risk:
  - `/exit` and `/account` are source-pinned (exit needs the process registry; account restart is delayed). Keepalive, shutdown, and idle watchdog are source-pinned plus idle-lifecycle / reconnect-profile coverage.
  - `run.failed` logs an implied `stopReason` for timeout/interrupted terminals without mutating the handle first, so flag-off still delivers the timeout event then maps it to `idle_timeout`.
  - Agent CLIs are **not** detached (same process group) until ticket 4's orphan reaper. A SIGKILL of the bridge still kills in-flight CLIs.
  - Signature table is empty this ticket (ticket 5). Flag off: `profile.reliability.runOutcome: false` matches master (drop non-system events after interrupt; runner timeout renders as `idle_timeout`).
