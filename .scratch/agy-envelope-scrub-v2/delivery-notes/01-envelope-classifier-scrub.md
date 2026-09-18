# Delivery note: 01 SYSTEM_MESSAGE envelope classifier scrub

**Status:** delivered

- Code PR: https://github.com/Rainnystone/larkent/pull/32
- SHA:
  - red fixtures/tests: `0c323e7`
  - green implementation: `f8c96f7`
  - review follow-up (C1 first-closer lock, named C2/C3, CONTEXT fingerprint disambiguation): `eaacee9`
  - branch HEAD at delivery: `eaacee9`
- Evidence:
  - TDD red: `pnpm exec vitest run tests/unit/agent/antigravity-jsonl.test.ts tests/unit/agent/antigravity-envelopes.test.ts` → 12 failed / 25 passed. Translator assertions failed for the intended #30 over-scrub (B1–B4 citations / B4 peel-to-end, A4 preamble wipe, C1 depth peel, T1 missing classifier / `tag_retained` fields). A1/A2/A3/B5/C2/C3 stayed green (Incident A leak still stripped). Envelopes file failed collect (`src/agent/antigravity/envelopes` missing).
  - TDD green: same two files → 50 passed after `f8c96f7`; 52 passed after `eaacee9` (added C2 matrix row + C3 FAILED).
  - `pnpm ci:local` on `f8c96f7`: exit 0 (152 test files passed / 4 skipped; typecheck + build green).
  - Both `translateResult` and `prependHeldBack` paths: A1/B4 covered on `fail()` held-back flush; A2/A3/A4/B1–B5/C1/C2/T1 on `result.response`. Shared helper `scrubSystemMessageEnvelopes` in `src/agent/antigravity/envelopes.ts`.
  - #30 unclosed test rewritten for B4: `strips every envelope in one body including an unclosed opener` → `B4: keeps an unclosed non-fingerprinted opener and trailing prose byte-identical`.
- Residual risk:
  - Fullwidth / lookalike tags (`【SYSTEM_MESSAGE】`) out of scope
  - `<task_notification>` is ticket 02
  - A2 raw Incident A payload is redacted; cite `om_x100b65e6a11b3cb4b10254b74b00974`
  - Unclosed JSON `task_complete` envelopes without a D3 `[Message]` / preamble envelope fingerprint are left byte-identical (D4). Incident A was balanced.
