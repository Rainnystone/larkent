# Delivery note: 01 scrub SYSTEM_MESSAGE final_text

**Status:** delivered

- Code PR: https://github.com/Rainnystone/larkent/pull/30
- SHA: `dea83e0a98f5c00a00e2dd5dce68ec1f45daae14`
- Evidence:
  - TDD red: 6 new translator tests failed because `final_text` still contained `<SYSTEM_MESSAGE` and no scrub log fired.
  - TDD green: `pnpm exec vitest run tests/unit/agent/antigravity-jsonl.test.ts` — 23 passed.
  - Nearby: `pnpm exec vitest run tests/unit/agent` — 202 passed.
  - `pnpm typecheck` — clean.
  - `pnpm ci:local` — passed (diff check, full test suite, typecheck, build).
  - Incident fixture `tests/fixtures/antigravity/system-message-envelope-incident.jsonl`: envelope prepended to `收到！已经根据你的要求整理完初稿。` emits that prose only.
  - Shared `emitScrubbedFinalText` used by `translateResult` and `prependHeldBack` (`fail()` path). Envelope-only SUCCESS is silent or uses the existing print-timeout hint. ERROR / FAILED mapping unchanged. `jsonl.system_message_scrubbed` logs `{ beforeLength, afterLength }` once and never the body.
  - Diff vs `master` is translator + fixture + unit tests only. No `.scratch` on the code PR.
- Residual risk:
  - Only the case-sensitive `<SYSTEM_MESSAGE>` tag is stripped. A later envelope family needs a follow-up ticket.
  - Scrub runs at emit, on the chosen `result.response` or `pendingText` string. An envelope that exists only on the unused source stays unused (existing prefer-`response` rule).
  - No live Feishu / agy turn was run. CI on macOS / Windows was still pending when this note was written. Ubuntu CI had already passed.
