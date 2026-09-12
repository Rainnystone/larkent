# Delivery note — 01 Recognize `tool` / `checkpoint`

**Status:** done
**Claimed by:** code track on [#28](https://github.com/Rainnystone/larkent/pull/28)
**Docs PR:** [#27](https://github.com/Rainnystone/larkent/pull/27)
**Feat PR:** [#28](https://github.com/Rainnystone/larkent/pull/28)
**SHA:** `40b4aebcca223c3ac44d3792da80191b83a12e88`

## Evidence

- [x] Unit tests at the translator seam (fixture paths): `tests/fixtures/antigravity/tool-checkpoint-steps.jsonl`, `tests/unit/agent/antigravity-jsonl.test.ts`
- [x] `unknownEvents` for official `tool` / `checkpoint` is 0
- [x] No `tool_use` / `tool_result` events
- [x] Existing success / ERROR / unknown-type cases still pass
- [ ] Optional local live `agy` stream-json capture (not required for Cloud): not run

TDD: failing-before `protocolDrift().unknownEvents === 5` (4× `tool` + 1× `checkpoint`). Passing-after: 9/9 in `antigravity-jsonl.test.ts`. `pnpm ci:local`: 1366 passed, 4 skipped; typecheck and build clean.

## Residual risk

- Empty SUCCESS after print-timeout still finishes as `done(normal)` with no body; outbound may still `skip-empty`. That is ticket 02.
- Official `tool_info` is not mapped onto shared `tool_use` / `tool_result` (intentional parse-only).
- Fixture is incident-shaped but compact (two tools + one checkpoint), not the captured ~137-tool stream.

## Notes

Parse only. No Feishu process/progress cards. Tickets 02 and 03 are not in this slice.
