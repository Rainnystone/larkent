# Delivery note: 5: per-adapter CLI 签名表、golden stderr、脱敏文案、有界 stderr

**Status:** delivered (deterministic layer)

- Code PR: [#39](https://github.com/Rainnystone/larkent/pull/39)
- SHA: `151aa1f8a01917efde3a78a050f3e1fc86678c83` (`feat/run-reliability`)
- Evidence:
  - TDD red: descriptor `stderrSignatures` missing; `BoundedStderr` module missing; `reliability.cliSignatures` undefined; cards showed raw path/account stderr; exit 0 print-timeout stayed `completed`; runner had no `stderrSnapshot`.
  - TDD green: per-adapter tables (observed cursor/agy; grok/kimi `synthetic: true`; claude/codex empty); shared `matchCliSignature` in `src/agent/cli-signatures.ts`; `BoundedStderr` 32 KiB head+tail; runner snapshot used for matching (not the 500-char error slice); `reliability.cliSignatures` default on. Tests: `tests/unit/agent/cli-signatures.test.ts`, `tests/unit/agent/bounded-stderr.test.ts`, `tests/process/jsonl-cli-runner.test.ts` (snapshot + 500-char gap), `tests/integration/bot/run-outcome-stream.test.ts` (redacted stall/unclassified, flag-off raw copy, agy partial).
  - `pnpm ci:local`: green on `151aa1f` (typecheck + full vitest + build).
  - test bridge: live `e2e:up` was **not** run (no isolated tester credentials; live data root not touched). Deterministic goldens under `tests/fixtures/goldens/stderr/` cover the observed signatures. No ids or tokens recorded.
- Residual risk:
  - Flag off: `profile.reliability.cliSignatures: false` matches master (no signature matching; cards keep truncated raw stderr).
  - Keepalive `agent-version-check-timeout`, agy background-task warnings, and `post-done-exit-timeout` are not run-outcome signatures (appendix A).
  - Agent CLIs stay in the bridge process group until ticket 4. A SIGKILL of the bridge still kills in-flight CLIs.
  - Live test-bridge replay still pending credentials (same residual as 0b/1).
