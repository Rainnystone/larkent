# Delivery note: 0b: repo 内隔离 test bridge 与确定性 vitest 层

**Status:** delivered (harness + deterministic layer)

- Code PR: [#39](https://github.com/Rainnystone/larkent/pull/39)
- SHA: `670cc672fc348a1adf8ba24c52cc423945822541` (`feat/run-reliability`)
- Evidence:
  - TDD red: missing `e2e/test-bridge/{config,shim,proxy}` modules; `git check-ignore e2e/.local/test-bridge.json` failed.
  - TDD green: `tests/integration/e2e-harness` 15 tests (config rejects placeholders + live root; gitignore + no committed id shapes; shim `--version`/`--help` passthrough, SIGTERM without `stdout did not quiesce`, one-shot runId filter; proxy disconnect / timeout / EPROTO-family / EAI_AGAIN / slow / host select).
  - `pnpm ci:local`: green on `d1975e7` (typecheck + full vitest + build).
  - test bridge: scenario `redelivery-short-gap` is implemented. Live `e2e:up` / send / read / 20–30s disconnect was **not** run here (no isolated tester credentials in this environment; live data root not touched). No ids or tokens recorded.
- Residual risk:
  - Ticket 1 short-gap strategy still needs the live redelivery experiment once `e2e/.local` is filled.
  - After `e2e:up`, `fault proxy eai_again` destroys CONNECT sockets rather than advertising a second unresolvable host.
  - POSIX-only; Windows CI skips the shim process tests.
  - No production behavior change (0a fence remains off by default).
