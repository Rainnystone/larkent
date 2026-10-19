# Task 9f — P09f 最终回复原样搬运协议字段

**Status:** ready-for-agent · bug · P3
**Delivers:** 自动化相关回复用用户语言说明状态（如“已发确认卡，点「是」后生效”），不原样输出 `waiting-confirmation`、`applied: false` 等机器字段。
**Found in:** [P09](P09-real-feishu-acceptance.md) 场景 3，候选版本 `0b55865`（Grok，其他 CLI 类似）
**Worker class:** mechanical（skill 文案）
**Blocked by:** None

## Bug

- **场景：** 新会话创建提醒，工具返回 `waiting-confirmation`。
- **期望：** 回复区分“等待确认”和“已生效”（User story 6），面向用户解释由 skill + 模型承担（D7）。
- **实际：** 回复直接暴露 `waiting-confirmation`、`applied 为 false` 和完整 operationId。状态语义正确（“尚未生效，点「是」后才会保存”）；规格不禁止返回操作编号，但 SKILL.md 没有指导把机器状态翻译成用户语言，各 CLI 都照搬协议字段。
- **严重度：** P3（可读性，非契约违背）。

## Evidence

- P09 场景 3 的 Grok 运行日志与回复回读（盒子本地 P09 归档）。

## Root cause（`0b55865`）

- `plugins/automation/skills/automations/SKILL.md`：描述了结果类别，但没有“如何向用户表述”的指导与示例，模型默认原样引用字段。

## What to build

- 在 automation skill 中加入结果类别 → 用户表述的对照（等待确认、已应用、需要补全、校验失败、结果未知、执行失败），并说明 operationId 只在需要追查时简短提及（例如“操作编号末 6 位”或不提），不输出 JSON 字段名或布尔值。
- 不改协议与结果结构。

## Acceptance criteria

- [ ] SKILL.md 含上述对照与至少两个正反示例；skill 相关快照/目录测试更新并通过。
- [ ] catalog/prompt 测试确认对照内容可经 `plugins.read` 读到。
- [ ] `pnpm ci:local` 通过。
- [ ] P09 重跑：Grok、Cursor、Kimi 各创建一个提醒，回复不出现 `waiting-confirmation`、`applied`、`true/false` 等字段名，仍明确“点「是」后生效”。
