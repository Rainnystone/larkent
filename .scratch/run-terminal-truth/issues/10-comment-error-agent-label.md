# 10: Comment error replies always say "Claude"

**Blocked by:** None · **Status:** ready-for-agent · **Scope:** not in scope for code PR #70 (pre-existing on master; filed from the #70 review round 7)

## Symptom

When a document-comment run fails, the reply always starts `⚠️ Claude 报错：…`, whatever agent the profile runs (agy, codex, cursor, grok, devin…). Users of a non-Claude profile are told Claude failed.

## Evidence

- master `2b2c2ea2`: `src/bot/comments.ts:403` `if (errorMsg) reply = \`⚠️ Claude 报错：${errorMsg}\`;`
- code PR #70 `8c518a7e`: `src/bot/comments.ts:416` (same prefix, plus the ticket-02 notice).
- code PR #70 `5d7aa444`: `src/bot/comments.ts:419` (unchanged prefix).
- Chat failures already use a neutral label (`⚠️ agent 失败`), so only the comment path is wrong.

Reproduces on master and on every #70 head since. Found by local Devin's round-7 review (box evidence `/workspace/rt-e2e-evidence-20261109/round7-review/REPORT.md` §3 T1, not committed).

## What to build

Use the profile agent's display name from its descriptor (`descriptorFor(capability.agentId)`) or a neutral `⚠️ agent 报错：` prefix, matching the chat path. Keep the ticket-02 new-session notice and its truncation reserve (`e93f3281`) intact.

## Acceptance
- [ ] A `tests/integration/comments/comment-run-flow.test.ts` case per non-Claude agent (at least agy and codex) asserts the agent-correct or neutral prefix; it fails before the fix.
- [ ] The Claude profile's comment error reply is unchanged, or changes only to the chosen neutral wording, by explicit decision.
- [ ] The new-session notice still survives a 2000-char-limit error (existing test stays green).
- [ ] Local gate green (`git diff --check && pnpm build:web && pnpm exec vitest run --maxWorkers 2 --minWorkers 1; pnpm typecheck && pnpm build:ci`).
