# Delivery note: 02 task_notification envelope family #2

**Status:** delivered

- Code PR: https://github.com/Rainnystone/larkent/pull/32
- SHA:
  - red fixtures/tests: `447b151`
  - green implementation: `fdadb17`
  - branch HEAD at delivery: `fdadb17`
  - pre-02 tip / review fixed point: `eaacee9`
- Evidence:
  - TDD red: `pnpm exec vitest run tests/unit/agent/antigravity-jsonl.test.ts tests/unit/agent/antigravity-envelopes.test.ts` on `447b151` → 15 failed / 57 passed. TN1/TN2 leaked the `<task_notification>` prefix on the pure module and both translator seams (`translateResult` / `prependHeldBack`). TN3–TN6 failed for missing `taskNotificationRetainedReasons` / sibling retain logs. 01 classifier rows (A1–T1, B4 peel-to-end lock, C1–C3) stayed green.
  - TDD green: same two files on `fdadb17` → 72 passed. TN1 `final_text` is the vitest title (`nested <SYSTEM_MESSAGE> blocks`) plus `这是给用户看的中文答复。`; no `<task_notification`; title citation byte-identical (no peel-to-end).
  - `pnpm ci:local` on `fdadb17`: exit 0 (152 test files passed / 4 skipped; 1462 tests passed; typecheck + build green).
  - Both emission paths: TN1 on `result.response` and `prependHeldBack` / `fail()` held-back flush. Shared helper remains `scrubSystemMessageEnvelopes` in `src/agent/antigravity/envelopes.ts` with family row `TASK_NOTIFICATION_ENVELOPE_SHAPES` (empty — no fingerprint confirmed).
  - Telemetry: sibling `task_notification_scrubbed` / `task_notification_tag_retained` with `family: 'task_notification'`; 01 `system_message_scrubbed` / `system_message_tag_retained` payloads unchanged for SM-only bodies.
- Code-review (Standards + Spec, fixed point `eaacee9`):
  - Spec: D13/TN1, D1 positional + D2 code-context, D4 analog (balanced strip; unclosed retained until a fingerprint row exists), D7 ERROR untouched, D8 same translator seam. No channel / sanitizer / 01 classifier rewrite.
  - Standards: family table extension only; exhaustive `EnvelopeFamilyId` switch; no `.scratch/` or Spec on the code PR. Non-blocking: `unclosed` / `preambleRemoved` on sibling logs are still aggregate; public helper name stays `scrubSystemMessageEnvelopes`.
  - Blocking findings: none.
- Residual risk:
  - No task_notification fingerprint shape confirmed — `TASK_NOTIFICATION_ENVELOPE_SHAPES` is empty; unclosed TN is retained (not peel-to-end).
  - Fullwidth / lookalike tags (`【SYSTEM_MESSAGE】`, etc.) still out of scope.
  - Sibling TN logs reuse aggregate `unclosed` / `preambleRemoved` if a future mixed body strips both families.
