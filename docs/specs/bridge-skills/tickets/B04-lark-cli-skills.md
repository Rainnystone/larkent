# [Superseded] B04 — lark-cli how-to leaves the system prompt: `lark-cli` and `lark-user-identity` skills, catalog on every run kind

Status: superseded · Revision 2.1 reference only · Replaced by Revision 3 · Do not claim or implement

> 当前依据为 [Revision 3](../../bridge-skills.md)。以下保留旧票内容用于追溯，不是当前实施要求；下一阶段重新运行 to-tickets。

## What to build

Today the lark-cli environment rules are injected twice (system prompt section and the per-turn `BRIDGE_AGENT_INSTRUCTIONS`), and the identity rules and OAuth flow sit in the system prompt of every run, so unattended runs need an addendum telling the model to ignore them. After this ticket the same text lives in two skills, gated by run kind, and every run kind gets a catalog. Behaviour of lark-cli itself is unchanged.

1. **Tools.** Add `lark-cli` (available on every run) and `lark-cli-user` (available on run kind `im` only) to the module's tool table.
2. **Skills (behaviour-equivalent move, no wording changes beyond de-duplication).**
   - `lark-cli` (`bridge-tools: lark-cli`): bridge-bound environment variables, never unset `LARK_CHANNEL*` / `LARKSUITE_CLI_CONFIG_DIR` or use `env -u`, "context detected but not bound" → stop and ask for restart / doctor / preflight, never read keys from `config.json`, multi-profile config, speaking in Feishu is always bot identity. Merge `BRIDGE_AGENT_INSTRUCTIONS` into it; keep only agent-kind-neutral facts (Decision N7: drop the Codex-specific sentence, keep "the bridge subprocess can reach the keychain like a local terminal").
   - `lark-user-identity` (`bridge-tools: lark-cli-user`): when reads / asset operations may use `--as user`, the 230027 fallback, the full OAuth device flow (p2p only, never in the background, two-phase `--no-wait` then `--device-code`, strict-mode / default-as convergence kept internal, queueing and `/stop`).
3. **System prompt.** Remove those three sections from the shared system prompt (all six agent kinds). The automation variant's addendum drops "ignore the identity and OAuth sections above" (the skill is simply not in an `auto:` catalog) and keeps only its contract lines: bot identity only, no personnel / org operations, what is allowed. Policy-guard is unchanged.
4. **Per-turn instructions.** Delete `BRIDGE_AGENT_INSTRUCTIONS`; the IM `bridge_instructions` section then carries only turn facts.
5. **Catalog on every run kind.** Build a turn context and render the same `<bridge_skills>` section, first in the user message as on IM turns, in the agent-task fire prompt (`auto`), the doc-comment prompt (`comment`) and the meeting prompt (`meeting`). Each gets the skills its tools allow (at least `lark-cli`).
6. **Guard.** Extend B01's prompt-section guard to these builders.

## Source (953e7bd)

- `src/bot/channel.ts:236-241` `BRIDGE_AGENT_INSTRUCTIONS`; merged into instructions at `:3960-3963`.
- `src/agent/bridge-system-prompt.ts:97-137` (lark-cli 运行环境 incl. 身份规则 at `:109`, 飞书 OAuth 授权 at `:118`); `AUTOMATION_BRIDGE_PROMPT_ADDENDUM` `:146-152`; `buildBridgeSystemPrompt` `:154`. Delivery per agent kind: Grok `--rules` (`src/agent/grok/adapter.ts:77`), Claude system-prompt file (`src/agent/claude/adapter.ts:81`), prefixed prompt for Cursor / Antigravity / Kimi / Codex (`prefixBridgeSystemPrompt`).
- Agent-task prompt `formatAutomationAgentPrompt` `src/automations/agent-run.ts:72`; variant set at `:270`.
- Comment prompt `buildCommentPrompt` `src/bot/comments.ts:485` (caller `:163`); meeting prompt `buildMeetingPrompt` `src/meeting/orchestrator.ts:213` (runner `:314`).
- Tests: `tests/unit/agent/bridge-system-prompt.test.ts`, `tests/unit/agent/adapter-system-prompt-wiring.test.ts` (migrate assertions on the moved sections onto the skills, then delete them).

## Acceptance criteria

- [ ] Integration (`startChannel` + `FakeAgentAdapter`): a human group or p2p turn lists `lark-cli` and `lark-user-identity` in `<bridge_skills>` with absolute paths; the prompt no longer contains `BRIDGE_AGENT_INSTRUCTIONS` text (for example `env -u LARK_CHANNEL` appears only in the skill file, not in the prompt).
- [ ] An agent-task fire's prompt lists `lark-cli` and not `lark-user-identity` or `automations`; its system prompt (automation variant) contains no "忽略上文" sentence and still states bot identity only and the personnel / org ban.
- [ ] A doc-comment run and a meeting run each carry a catalog with `lark-cli`.
- [ ] Unit on the system prompt for every registered agent kind: the lark-cli environment, identity-rule and OAuth sections are gone; `bridge_context`, bot-at-bot, final reply, `quoted_message`, `interactive_card`, identity and the `<bridge_skills>` contract sentence remain.
- [ ] Skill contract: every rule removed from the system prompt and from `BRIDGE_AGENT_INSTRUCTIONS` appears in `lark-cli` or `lark-user-identity` (assert key phrases, for example `--no-wait`, `--device-code`, `p2p`, `230027`, `LARKSUITE_CLI_CONFIG_DIR`); no rule appears in both.
- [ ] Prompt-section guard covers the IM, agent-task, comment and meeting builders.
- [ ] Policy-guard tests unchanged and green.
- [ ] `pnpm ci:local` passes in the worktree.

## Out of scope

Enforcing in code what these skills only describe (group OAuth, unsetting env), Decision N6 (a later tool ticket). Card callback rules (B05). Comment / meeting reply rules (B06).
