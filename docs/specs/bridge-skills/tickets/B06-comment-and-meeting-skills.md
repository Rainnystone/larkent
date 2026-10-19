# B06 — Doc-comment and meeting reply rules become the `doc-comment` and `meeting-reply` skills

Status: ready-for-agent · Blocked by: B01, B04 (B04 puts the catalog on comment and meeting prompts) · Track: code branch `feat/bridge-skills` (refs verified at `953e7bd`) · One ticket per session

## What to build

The last hard-coded how-to text lives inside the doc-comment and meeting prompt builders. Move it into two skills; the builders keep only turn facts. After this ticket, the prompt-section guard should find no instruction text outside the bridge contract, turn facts and the catalog (Spec D7).

1. **Tools.** Add `comment-reply` (run kind `comment`) and `meeting-reply` (run kind `meeting`) to the tool table: the bridge posts the final answer for these surfaces.
2. **Skill `doc-comment`** (`bridge-tools: comment-reply lark-cli`): how to read the target by file type (docs v2 fetch for doc / docx, the sheet path, the file path; do not loop on the same incompatible-argument error), the bridge posts the comment reply (do not call comment / reply / reaction APIs), plain-text reply rules (no markdown, no code blocks, no internal reasoning or tool logs; explain only user-visible grounds). The `file_token` placeholder in the read command becomes a reference to the turn fact.
3. **Skill `meeting-reply`** (`bridge-tools: meeting-reply`): answer from the meeting context, concise (about 200 characters), no markdown headings.
4. **Builders.** Comment prompt keeps: doc link, `file_token`, type, comment range, selected text, prior thread, the question. Meeting prompt keeps: the "you are in a meeting" fact, topic, transcript, who asked, the question. Both already carry the catalog from B04.
5. **Description wording.** Because these skills apply to every run of their kind, their descriptions start with the run kind as the leading word (for example 「云文档评论 run：回复前先读」). Decision N4: no inline full text; B07 records whether agents read them.

## Source (953e7bd)

- `src/bot/comments.ts:485-520` `buildCommentPrompt`; `commentReadInstruction` `:703-720`.
- `src/meeting/orchestrator.ts:212-235` `buildMeetingPrompt`.
- Tests: `tests/unit/comments/comment-parser.test.ts` (prompt assertions), `tests/unit/meeting/`.

## Acceptance criteria

- [ ] A comment run's prompt carries the doc facts and the question, lists `doc-comment` (and `lark-cli`) in the catalog, and contains none of the moved rule text (for example `不要 markdown`, `docs +fetch --api-version v2`).
- [ ] A meeting run's prompt carries the transcript facts, lists `meeting-reply`, and no longer contains `200 字`.
- [ ] IM turns and agent-task fires list neither skill.
- [ ] Skill contract: key phrases of every moved rule are in the skills; nothing moved is left in the builders.
- [ ] Prompt-section guard: every section of every builder is tagged contract / turn fact / catalog; no untagged how-to text remains (Spec D7 closed).
- [ ] `pnpm ci:local` passes in the worktree.

## Out of scope

Changing how the bridge posts comment replies or meeting answers.
