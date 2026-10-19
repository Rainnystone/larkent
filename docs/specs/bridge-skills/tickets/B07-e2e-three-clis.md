# B07 — E2E on the test bridge: Grok Build, Antigravity CLI, Cursor CLI

Status: ready-for-human · Blocked by: B01, B02, B03, B04, B05, B06 · Track: test bridge on the head of `feat/bridge-skills` (no code unless a finding becomes a new ticket) · One session

## What to verify

The skill catalog works without any CLI-native skill install and without `--trust`, on all three agent kinds, for every skill shipped. Use the test bridge (`pnpm e2e:up` …) in a test group and a p2p chat, one profile per agent kind, `automations.enabled` on. Nothing installed under `~/.agents/skills` for this feature.

## Scenarios (each on Grok Build, Antigravity CLI, Cursor CLI)

Automations skill

1. 「每天 9 点提醒我写日报，到今年年底」 → first reply proposes `每天 09:00 until <year-end>`; confirm card on the first try. Record whether the agent read the `automations` `SKILL.md` (tool log / stream).
2. 「每 2 小时提醒喝水，9 点到 18 点，到下周五」 → `every 2h 09:00-18:00 until …`; card.
3. 「每周一三五 10:00 站会，到月底」 → `每周 一、三、五 10:00 until …`; card.
4. Force a rejection (below the floor, e.g. 「每 5 分钟提醒一次，到明天」) → bridge line contains 未生成确认卡; model text does not promise a card. Next message 「那就按最小间隔」 → the agent fixes it using the injected reason (`interval-too-small`); card.
5. Profile with `automations.enabled` false → asking for a reminder yields no proposal, no mention of the tool, and no `automations` line in the catalog.
6. An `auto:` agent-task fire's prompt lists `lark-cli` only (check the run log / prompt dump); its task output uses bot identity.

Migrated skills

7. In p2p, 「帮我授权用户身份」 → the agent reads `lark-user-identity` and runs the two-phase device flow; in the group, the same request gets the "please DM me" answer.
8. 「发一张有 A / B 两个按钮的卡让我选」 → the agent reads `interactive-card`; tapping a button returns `[card-click]` to the same session.
9. @ the bot in a doc comment → the agent reads `doc-comment`, reads the doc, and the reply is plain text with no markdown.
10. Ask the bot a question in a meeting (where the test setup allows) → short answer, no headings.

## Acceptance

- [ ] Scenarios 1–10 pass on all three agent kinds (10 where meeting is available); results recorded in this PR as a comment (no Feishu IDs; redact to last 4).
- [ ] Grok Build without `--trust` can read every catalog path at its absolute location outside its working directory (the per-profile bridge workspace); record the evidence.
- [ ] Record, per agent kind and skill, whether the agent actually read the `SKILL.md` when it applied (input for Decision N4's follow-up: inline only if read rates are low).
- [ ] If a CLI cannot read the absolute path under its access mode or sandbox, record it and open a new ticket for that agent kind (Q6: an agent-facing command wrapping **read skill**) instead of patching here.
