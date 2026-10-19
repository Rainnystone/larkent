# [Superseded] B03 — Automations skill: rejected proposals never read as "card coming": bridge line says no card; skill wording stops promising one

Status: superseded · Revision 2.1 reference only · Replaced by Revision 3 · Do not claim or implement

> 当前依据为 [Revision 3](../../bridge-skills.md)。以下保留旧票内容用于追溯，不是当前实施要求；下一阶段重新运行 to-tickets。

## What to build

Observed 2026-10-19: the model's text promised a confirm card, while the bridge line at the end of the same reply said the task was not created. The model writes its text before the bridge validates, so it cannot know the outcome. Fix it deterministically on the bridge side and stop teaching the model to talk about the card.

1. **Bridge line.** Every rejection, refusal and unknown-id line the bridge appends to a proposal reply states explicitly that no confirm card was generated, for example `⚠️ 没有创建任务，未生成确认卡：无法解析时间表「every 1d 09:00」。…`. Same for 没有删除任务 / 没有替换任务. Success lines (`已生成确认卡…`) are unchanged. The bridge still does not rewrite the model's text.
2. **Kind-aware suggestion.** For `invalid-schedule`, the 「可写成…」 examples match the proposal: if the rejected text looks recurring (starts with `every` / `每` / `从` or has an end suffix), suggest recurring forms (`每天 09:00 until <date>`, `every 2h 09:00-18:00 until <date>`); otherwise keep the one-shot forms. Dates come from the injected clock, never hard-coded.
3. **Skill wording.** The `automations` `SKILL.md` reply-wording section (Spec D8 section 7) becomes positive and card-neutral: restate the understood time and task; the bridge's last line reports whether a confirm card was generated; never say created / updated / deleted / replaced. Remove the instruction that made the model mention 「点确认卡上的「是」后生效」. Keep the replace-vs-new two-option wording for edit requests.

## Source (953e7bd)

- `automationRejectReplyLine` `src/automations/command.ts:291-300` (verb, stem, fixed one-shot examples from `rejectionAbsoluteExample`).
- `automationProposalSuffix` `command.ts:302-339` (reject / refuse / unknown-id branches); `proposalVerb` `:368`.
- `replaceProposalLineAfterApply` `command.ts:349` (a replace that did not post a card must not keep a card claim; keep that behaviour).
- `automations` `SKILL.md` from B01, reply-wording section.

## Acceptance criteria

- [ ] Integration (prior art `tests/integration/bot/auto-proposal-reply.test.ts`): fake agent text 「好的，我给你发确认卡」 + an invalid proposal → the delivered reply's bridge line contains 未生成确认卡 and no card is posted.
- [ ] Same for refuse (`agentTasks` off) and unknown-id delete: line contains 未生成确认卡.
- [ ] Valid proposal → line is still 「已生成确认卡，点「是」后生效。」 and a card is posted.
- [ ] Unit: rejected `every 1d 09:00 until <date>` → suggestion contains a recurring form (`每天 09:00`); rejected one-shot garbage → one-shot forms; all example dates are on or after the injected `now` and move with it.
- [ ] Unit on `SKILL.md`: reply-wording section contains no instruction to mention the confirm card, and still forbids claiming created / updated / deleted / replaced.
- [ ] Existing `past-time` single-suggestion copy (A32) unchanged apart from the no-card phrase.
- [ ] `pnpm ci:local` passes in the worktree.

## Out of scope

Stripping or rewriting model text. Parser changes.
