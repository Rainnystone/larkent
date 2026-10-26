# 01 — Grok translator keeps the idle watchdog alive while it holds back the answer (tracer)

Spec: `docs/specs/grok-idle-watchdog.md` (Evidence, Root cause, Chosen fix, Failure cases, Testing).
Blocked by: none.
Code branch: `fix/grok-idle-watchdog`. Touch only `src/agent/grok/**` and Grok tests/goldens.

## Do

1. Red first: add the regression test (Spec › Testing › 2). Confirm it fails on the current code (watchdog stop, no answer).
2. Red: extend the Grok translator unit tests for the liveness contract (Spec › Testing › 1).
3. Green: in `GrokJsonlTranslator.queueText` (`src/agent/grok/jsonl.ts`), return `[{ type: 'system' }]` for each non-empty buffered chunk. Change nothing else in behavior.
4. Update Grok goldens/contract tests only where the new `system` events require it.
5. `/code-review` the diff against the Spec and its Non-goals.

## Acceptance

- [ ] Regression test is red on `origin/master` and green on the branch.
- [ ] Unit tests: one bare `system` per non-empty `text` chunk, none for empty chunks; no `text` delta for answer chunks; one `final_text` at `end` equal to the concatenation; pre-tool text, `error` and `fail` flushes unchanged.
- [ ] All other Grok tests, `tests/integration/bot/idle-lifecycle.test.ts`, `tests/unit/bot/final-reply.test.ts` and Devin tests stay green.
- [ ] No change outside `src/agent/grok/**` and tests/goldens. No `.scratch` or Spec files in the diff. No `src/bot/**` change.
- [ ] CI green on the code PR head.
- [ ] Test bridge E2E (grok, `runIdleTimeoutMinutes: 1`): a long no-tool answer arrives whole with no `idle_timeout`; a short question gets exactly one reply. Evidence goes in the code PR's Verification block without chat ids or names.
