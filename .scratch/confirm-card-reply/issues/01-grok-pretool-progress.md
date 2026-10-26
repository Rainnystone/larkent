# 01 — Grok pre-tool text becomes progress (tracer)

Spec: `docs/specs/confirm-card-reply.md` (Problem row 1, Approach T1).
Blocked by: none.
Code branch: `feat/confirm-card-reply`. Touch only `src/agent/grok/**` and Grok tests.

## Do

1. Red: change the locking test `tests/unit/agent/grok-stop-answer.test.ts:55-71` to expect a progress event containing `before the tool` and `final_text` equal to `after`.
2. Red: add sequence tests (below).
3. Green: replace `keepPendingBeforeTool` (`src/agent/grok/jsonl.ts` ~119-123) so buffered pre-tool text is emitted as the same progress event Kimi/Devin use and the buffer is cleared; remember the last non-empty pre-tool segment; if the final answer is empty at `end` or on user stop, use that segment.
4. `/code-review` against the Spec and Non-goals.

## Acceptance

- [ ] A, tool, B, tool, C → A and B as progress, `final_text` = C.
- [ ] Text, tool, no text after → `final_text` equals the last non-empty pre-tool segment (never empty).
- [ ] User stop after a tool with no text afterwards → stopped answer non-empty.
- [ ] No tools → behavior unchanged (existing hold-back and stop tests green).
- [ ] Other Grok tests, `tests/unit/bot/final-reply.test.ts`, `tests/integration/bot/idle-lifecycle.test.ts` green.
- [ ] No change outside `src/agent/grok/**` and tests. CI green on the code PR head.
