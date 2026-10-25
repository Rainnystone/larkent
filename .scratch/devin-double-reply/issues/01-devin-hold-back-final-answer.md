# 01 — Devin translator holds back the final answer (tracer)

Spec: `docs/specs/devin-double-reply.md` (Root cause, Chosen fix, Failure cases, Testing).
Blocked by: none.
Code branch: `fix/devin-double-reply`. Touch only `src/agent/devin/transcript.ts` and tests.

## Do

1. Red first: add the channel-delivery integration test (Spec › Testing › 2). It feeds scripted ACP updates through a real `DevinTranscriptTranslator`, runs with `agentKind: 'devin'` in `messageReply=markdown` and `card`, and asserts that exactly one visible message carries the answer. Confirm it fails on the current code (card + post).
2. Red: update or extend `tests/unit/agent/devin-acp.test.ts` for the hold-back contract (Spec › Testing › 1).
3. Green: in `DevinTranscriptTranslator`, buffer `agent_message_chunk` text per message id and emit no `text`. Flush it as one `text` delta before a new tool or on a message id change. Emit it only as `final_text` on `finish('end_turn')`. Flush it as `text` on `cancelled` and before `error`.
4. `/code-review` the diff against the Spec.

## Acceptance

- [ ] New integration test is red on `origin/master` and green on the branch, for markdown and card, answer-only and narration → tool → answer.
- [ ] Devin unit tests cover: no `text` for chunks; one `final_text` at `end_turn` equal to the concatenated chunks; flush before `tool_use`; flush on message id change; cancel → `text`, no `final_text`; fail → `text` then `error`; replay ignored.
- [ ] `tests/unit/bot/final-reply.test.ts`, `tests/unit/bot/cot.test.ts`, `tests/integration/bot/skip-cli-already-sent.test.ts` and the codex/grok/cursor translator tests stay green.
- [ ] No change outside `src/agent/devin/transcript.ts` and tests. No `.scratch` or Spec files in the diff.
- [ ] CI green on the code PR head.
- [ ] Test bridge E2E (Devin, markdown, one group question and one DM question): one reply each; the Typing reaction appears and is removed; the body is only the answer. Record the evidence in the code PR's Verification block without chat ids or names.
