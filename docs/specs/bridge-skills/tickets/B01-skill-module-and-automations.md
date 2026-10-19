# B01 — Tracer bullet: bridge skill module + per-turn catalog, with automations migrated as the first skill

Status: ready-for-agent · Blocked by: none · Track: code branch `feat/bridge-skills` (create from `origin/master` if absent; refs verified at `953e7bd`) · One ticket per session

## What to build

A group member asks the bot for a schedule in natural language. Instead of the hard-coded automations sentence, the prompt now ends with a short **skill catalog** that lists the `automations` skill with an absolute path to its shipped `SKILL.md`. The bot reads it when the request needs it and gets the grammar right. Bots or turns without the `automation-proposal` tool do not see it. Bridge validation is unchanged. This one slice proves the whole path: skill root on disk → module → gating → catalog in the prompt → shipped in the deployed package.

1. **Skill root + format.** A new top-level directory for bridge skills (not under `.agents/`, `.cursor/`, `.claude/`, `.codex/`, `.grok/` or any other directory a CLI auto-loads). One directory per skill, entry `SKILL.md`, frontmatter per Spec D2 (`name` = directory name, `description`, optional `metadata.bridge-tools` / `metadata.bridge-tools-optional`). Parse only the fields we use; add no YAML dependency unless the minimal parser cannot cover D2.
2. **Module (Spec D1).** One deep module with exactly two entry points, both taking a turn context: **list catalog** → visible entries `{ name, description, absolute path, optional tools off this turn }` sorted by name; **read skill** → full text, or nothing when gated. The skill root is injected (production root resolved from the bridge's own install location, correct from source and from `dist`; tests pass a temp fixture root). A broken skill is invisible plus one warn log; others are unaffected. No plugin system, no pluggable renderer.
3. **Tool table (Spec D3).** Inside the module: `automation-proposal` and `automation-agent-task`. `automation-proposal` uses the same predicate the settle path uses to honor proposals (`shouldHonorAutomationProposal`) plus group chat; `automation-agent-task` adds `automations.agentTasks`. Refactor so the settle path and the gate call one predicate; the p2p-only refusal in the planner stays as defence in depth.
4. **Catalog (Spec D4).** The prompt builder renders a `<bridge_skills>` section as the **first** section of the user message, before `bridge_context`, `bridge_instructions`, topic / quoted context and `user_input` (Decision N3: stable prefix right after the system prompt, prompt-cache friendly), when the catalog is non-empty: one lead line, then per skill one line (`name`, description, optional tools off this turn) and one line with the absolute path. Add one contract sentence to the system prompt saying what the `<bridge_skills>` block means and that unlisted capabilities are unavailable, and change its "`<bridge_context>` sits at the top of every user message" wording to "after `<bridge_skills>`".
5. **`automations` skill (Spec D8).** `bridge-tools: automation-proposal`, `bridge-tools-optional: automation-agent-task`. Sections 1–6 of Spec D8, plus section 7 that ports today's reply-wording rules verbatim (B03 changes them). Every rule in today's `AUTOMATION_PROPOSAL_INSTRUCTION` must land in the skill. Write it with `writing-for-agents` (https://github.com/mattpocock/skills): positive phrasing, leading words, single source of truth.
6. **Wire-up.** In the IM run path, stop pushing `AUTOMATION_PROPOSAL_INSTRUCTION` and delete the constant. `<group_automations>` snapshot injection is unchanged, but its condition follows the `automation-proposal` predicate.
7. **Packaging.** Add the skill root to `package.json` `files` and make sure the built package carries it next to `dist`.
8. **Guard.** A test that enumerates every section the IM prompt builder can emit and tags it contract / turn fact / catalog (Spec D7); an untagged section fails. It also asserts the order: `<bridge_skills>` first, `user_input` last.
9. **Glossary.** Add the Spec D10 words to `CONTEXT.md`.

## Source (953e7bd)

- `src/automations/proposal.ts:37-55` `AUTOMATION_PROPOSAL_INSTRUCTION` (rules to port, then delete); `shouldHonorAutomationProposal` `proposal.ts:255`; `shouldInjectGroupTaskSnapshot` same file.
- `src/agent/prompt.ts:86-110` section order (`bridge_context` is first today; the catalog goes in front of it).
- `src/bot/channel.ts:1837-1860` injection under `automations.enabled` plus the snapshot (`:1845` is the push to replace); `:2069` honor predicate at settle; `buildPrompt` `:3914-3970` → `buildAgentPrompt` `src/agent/prompt.ts:86` (`promptSection`, section order).
- System prompt: `src/agent/bridge-system-prompt.ts` (contract sentence goes here; it reaches all six agent kinds through their adapters).
- Grammar truth: `src/automations/command.ts` `parseScheduleText` (≈`:417`), `parseRelative`, `parseAbsolute`, `parseNamedDayTime`, `parseBareClock`, `parseStartPrefix`, `splitEndSuffix`, `parsePendingRecurring` (≈`:704`, `every` accepts only m / h); floors `src/automations/schedule.ts:3-5`.
- Reject reasons: `ScheduleTextRejectReason` `command.ts:103`, `ScheduleRejectReason` `schedule.ts:45`; refusals `AUTO_P2P_HINT`, `AUTO_AGENT_DISABLED`, `AUTO_AGENT_NEEDS_CWD`, `AUTO_NEW_USAGE` (`command.ts:51-58`); unknown-id; policy-guard `user-identity` (`src/automations/policy-guard.ts`).
- Packaging: `package.json` `files` (today `dist`, `bin`, READMEs, LICENSE); build `tsup.config.ts`.
- Tests to migrate (replace, don't layer): `tests/unit/automations/proposal.test.ts:138-150` assert instruction text; move them onto `SKILL.md`, then delete the old assertions.

## Acceptance criteria

- [ ] Integration (`startChannel` + `FakeAgentAdapter`, prior art `tests/integration/bot/auto-nl-creation.test.ts`): a human group message on a profile with `automations.enabled` yields a prompt whose first section is `<bridge_skills>` (before `bridge_context` and `user_input`) and lists `automations`, its description, and an absolute path; that path exists and the file starts with the frontmatter.
- [ ] Same seam: the prompt no longer contains the old instruction text (for example `块内仅一段 JSON`), and the catalog block is within the Spec D4 budget.
- [ ] Same seam: no `automations` entry (and no `<bridge_skills>` block when nothing else is visible) when `automations.enabled` is false; for an `auto:` or `meeting:` scope; in p2p; when the trigger is a bot message.
- [ ] Same seam: with `automations.agentTasks` false, the catalog line says `automation-agent-task` is unavailable this turn.
- [ ] Existing natural-language create / delete / replace integration tests still pass (same cards, same rejection lines).
- [ ] Module tests with a temp fixture root: a pure-guidance skill (no `bridge-tools`) is always listed; a skill needing an unavailable tool is not; a skill naming an unknown tool or missing `description` is not listed and the others still are; **read skill** returns the text when visible and nothing when gated; every returned path is absolute.
- [ ] Contract test over the real skill root: every skill has valid frontmatter, `name` equals its directory, every tool name is in the tool table, description within budget.
- [ ] Automations contract: for every member of the reject-reason set (driven from the type, so a new reason without a skill entry fails), `SKILL.md` has a recovery entry carrying that exact code; every schedule in the examples parses with `parseScheduleText` at a fixed `now`; every example marked invalid (at least `every 1d 09:00 until …`) fails with the stated reason.
- [ ] The skill states that scheduled agent tasks run with bot identity only: task text must never contain `--as user`, and it maps `user-identity` (policy-guard pause) to that fix, including that the bot app needs read access to the target resource.
- [ ] The catalog path is absolute, never relative: the agent CLI's working directory is the per-profile bridge workspace, not the package.
- [ ] `npm pack --dry-run` lists every `SKILL.md`; the production root also resolves from the built `dist` (unit test or a process test that builds once).
- [ ] Deploy check: after `pnpm build` and installing the built package the way the live bridge is deployed, the path the running bridge puts in the catalog exists on disk. JS-only output with no skill files is a failure.
- [ ] Prompt-section guard test exists and passes.
- [ ] `CONTEXT.md` has the new words. `pnpm ci:local` passes in the worktree (on a memory-tight host run the touched test files, then let CI run the full suite).

## Out of scope

Rejection feedback (B02). Reply wording and bridge rejection lines (B03). Migrating any other injected text (B04–B06). Parser changes (Q4). Agent-facing read command, extra skill roots, profile skill switches (Spec Out of Scope).
