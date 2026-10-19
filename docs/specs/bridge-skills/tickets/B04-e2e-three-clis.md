# B04 — E2E on the test bridge: Grok Build, Antigravity CLI, Cursor CLI

Status: ready-for-human · Blocked by: B01, B02, B03 · Track: test bridge on the head of `feat/bridge-skills` (no code unless a finding becomes a new ticket) · One session

## What to verify

The skill index works without any CLI-native skill install and without `--trust`, on all three agent kinds. Use the test bridge (`pnpm e2e:up` …) in a test group, one profile per agent kind, `automations.enabled` on. Nothing installed under `~/.agents/skills` for this feature.

## Scenarios (each on Grok Build, Antigravity CLI, Cursor CLI)

1. 「每天 9 点提醒我写日报，到今年年底」 → first reply proposes `每天 09:00 until <year-end>`; confirm card on the first try. Record whether the agent read the `SKILL.md` path (tool log / stream).
2. 「每 2 小时提醒喝水，9 点到 18 点，到下周五」 → `every 2h 09:00-18:00 until …`; card.
3. 「每周一三五 10:00 站会，到月底」 → `每周 一、三、五 10:00 until …`; card.
4. Force a rejection (ask for something below the floor, e.g. 「每 5 分钟提醒一次，到明天」) → bridge line contains 未生成确认卡; model text does not promise a card. Next message 「那就按最小间隔」 → the agent fixes it using the injected reason (`interval-too-small`); card.
5. Profile with `automations.enabled` false → asking for a reminder yields no proposal and no mention of the tool.
6. An `auto:` agent-task fire's prompt has no skill index (check the run log / prompt dump).

## Acceptance

- [ ] Scenarios 1–6 pass on all three agent kinds; results recorded in this PR as a comment (no Feishu IDs; redact to last 4).
- [ ] Grok Build without `--trust` can read the doc at its absolute path outside its working directory (the per-profile bridge workspace); record the evidence.
- [ ] If a CLI cannot read the absolute path under its access mode or sandbox, record it and open Q6 as a new ticket (inline fallback for that agent kind) instead of patching here.
