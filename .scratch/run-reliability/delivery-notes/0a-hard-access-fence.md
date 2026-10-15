# Delivery note: 0a: 统一硬 access 围栏、机器级 app 锁、live 根防护

**Status:** delivered

- Code PR: [#39](https://github.com/Rainnystone/larkent/pull/39)
- SHA: `a5613bc2f9ade939002ff488022cbfab44854639` (`feat/run-reliability`)
- Evidence:
  - TDD red: `evaluateAccess` / `machineAppLockFile` / `acquireMachineAppLock` missing; comment @bot still fetched (`wiki.getNode` + `fileComment.get`); card click still stopped the run; second supervisor start on another data root resolved instead of rejecting; `src/runtime/live-root` failed to load.
  - TDD green: access fence (5 entries), comment fence, card fence, live-root, machine-lock unit + cross-root supervisor tests pass.
  - `pnpm ci:local`: green (typecheck + full vitest + build) on that SHA.
  - test bridge: n/a — 0b not started; 0a covered by vitest only (no live Feishu, no IDs).
- Residual risk:
  - Keystore still derivable by the same OS user (out of scope; 0b fake CLI mitigates).
  - Comment fence is user-only (`sender ∈ allowedUsers`). It does not require `chat ∈ allowedChats`; comment events are not IM-chat-scoped. Documented in spec 5.1.
  - Live-root guard compares the default `~/.lark-channel` (and paths inside it), not a custom live `LARK_CHANNEL_HOME`.
  - Meeting summary with the fence on and no asker id fails closed (no owner fallback).
