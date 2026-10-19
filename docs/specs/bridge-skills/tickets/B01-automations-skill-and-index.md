# B01 — Tracer bullet: automations skill doc + capability-gated skill index replaces the hard-coded instruction

Status: ready-for-agent · Blocked by: none · Track: code branch `feat/bridge-skills` (create from `origin/master` if absent; refs verified at `953e7bd`) · One ticket per session

## What to build

A group member asks the bot for a schedule in natural language and the bot gets the schedule grammar right because, instead of the long hard-coded sentence, the prompt carries a short **skill index** pointing at a shipped `SKILL.md` for automations. Bots without automations see nothing. Bridge validation is unchanged.

End to end in one slice:

1. **Skill doc.** A new top-level directory for bridge skills (not under `.agents/`, `.cursor/`, `.claude/`, `.codex/`, `.grok/` or any other directory a CLI auto-loads), with `automations/SKILL.md`. Frontmatter `name: automations` and a model-facing `description` (leading word first, one trigger per branch: create one-shot / recurring, delete, replace). Body follows Spec D4 sections 1–5: when to use, proposal format, the full schedule grammar (including `every` = minutes / hours only, `每天` / `每个工作日` / `每周`, start prefix, end suffix, limits), examples for every grammar branch, and a recovery entry for every reason code in Spec D5 (heading or label contains the exact code). Section 6 (reply wording) ports today's rules verbatim; B03 changes it. Write it with `writing-for-agents` from https://github.com/mattpocock/skills: positive phrasing, leading words, no duplication. Every rule in today's `AUTOMATION_PROPOSAL_INSTRUCTION` must land in the doc.
2. **Packaging.** Add the directory to `package.json` `files`. A resolver returns the doc's absolute path from the bridge's own install location; it must be correct both when running from source (tests) and from `dist` (built CLI).
3. **Registry + index.** A small registry module: entries `{ name, available(ctx), docPath }`; description read from the doc's frontmatter. One exported function builds the index text for a turn context, or nothing. Automations `available`: `automations.enabled` && scope not `auto:` / `meeting:` && group chat (Spec D2; p2p is Open question Q2, default not injected). The index line also states when agent tasks are off (`automations.agentTasks` false → reminders only).
4. **Wire-up.** In the run path, push the index instead of `AUTOMATION_PROPOSAL_INSTRUCTION`; delete the constant. `<group_automations>` snapshot injection is unchanged.
5. **Glossary.** Add **bridge skill**, **skill index**, **reason code** to `CONTEXT.md`.

## Source (953e7bd)

- `src/automations/proposal.ts:37-55` `AUTOMATION_PROPOSAL_INSTRUCTION` (rules to port, then delete).
- `src/bot/channel.ts:1840-1858` injection under `automations.enabled` plus the snapshot; `:1845` is the push to replace.
- Grammar truth: `src/automations/command.ts` `parseScheduleText` (≈`:417`), `parseRelative`, `parseAbsolute`, `parseNamedDayTime`, `parseBareClock`, `parseStartPrefix`, `splitEndSuffix`, `parsePendingRecurring` (≈`:704`, `every` regex accepts only m / h units); floors in `src/automations/schedule.ts:3-5`.
- Reject reasons: `ScheduleTextRejectReason` `command.ts:103`, `ScheduleRejectReason` `schedule.ts:45`; refusals `AUTO_P2P_HINT`, `AUTO_AGENT_DISABLED`, `AUTO_AGENT_NEEDS_CWD`, `AUTO_NEW_USAGE` (`command.ts:51-58`), unknown-id.
- Packaging: `package.json` `files`; build `tsup.config.ts` (bundles to `dist/cli.js`, `dist/index.js`).
- Tests to migrate: `tests/unit/automations/proposal.test.ts:138-150` assert instruction text; move those assertions onto `SKILL.md`.

## Acceptance criteria

- [ ] Integration (`startChannel` + `FakeAgentAdapter`, prior art `tests/integration/bot/auto-nl-creation.test.ts`): a human group message on a profile with `automations.enabled` yields a prompt that contains the index line with `automations`, its description, and an absolute path; that path exists and its file starts with the frontmatter.
- [ ] Same seam: the prompt no longer contains the old instruction text (for example `块内仅一段 JSON`), and is shorter than before for that turn (assert the index block is under a fixed budget, e.g. 600 characters).
- [ ] Same seam: no index when `automations.enabled` is false; none for an `auto:` or `meeting:` scope; none in p2p (per default of Q2).
- [ ] Same seam: with `automations.agentTasks` false, the index says reminders only.
- [ ] Existing natural-language create / delete / replace integration tests still pass with the doc-driven prompt (bridge behaviour unchanged: same cards, same rejection lines).
- [ ] Doc contract unit test: for every member of the reject-reason set (driven from the type, so adding a reason without a doc entry fails), `SKILL.md` contains a recovery entry carrying that exact code.
- [ ] Doc examples unit test: every schedule in the doc's examples parses with `parseScheduleText` at a fixed `now`; every example the doc marks invalid (at least `every 1d 09:00 until …`) fails with the reason the doc states.
- [ ] Frontmatter `name` equals the registry entry name; `description` is non-empty.
- [ ] `npm pack --dry-run` lists the `SKILL.md`; the resolver's path also resolves from the built `dist` (unit test or a process test that builds once).
- [ ] Deploy check: after `pnpm build` and installing the built package the way the live bridge is deployed, the path the running bridge puts in the index exists on disk. JS-only output with no doc is a failure.
- [ ] The doc states that scheduled agent tasks run with bot identity only: the task text must never contain `--as user`, and it maps reason `user-identity` (policy-guard pause) to that fix, including that the bot app needs read access to the target resource.
- [ ] The index path is absolute, never relative: the agent CLI's working directory is the per-profile bridge workspace, not the package.
- [ ] `CONTEXT.md` has the new words. `pnpm ci:local` passes in the worktree (on a memory-tight host run the touched test files, then let CI run the full suite).

## Out of scope

Rejection feedback to the model (B02). Changing reply wording or bridge rejection lines (B03). Parser changes (Q4).
