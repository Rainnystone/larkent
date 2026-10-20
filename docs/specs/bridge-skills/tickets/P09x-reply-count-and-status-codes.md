# Task 9x — P09x 回复次数与卡片不一致，且泄漏 needs-input / waiting-confirmation

**Status:** done · fixed in #52 by 8d06360（2026-10-20） · bug · P3
**Owner:** Cursor Project
**Delivers:** 回复中的触发次数与确认卡一致；不出现协议状态码。
**Found in:** 真实飞书测试 bridge，代码 head `6dd0e44`（#52），2026-10-20 live 回归
**Worker class:** judgment
**Blocked by:** None

## Bug

- **实际：** 回复写“共 31 次”，同一草稿的确认卡显示“共 30 次”；回复中出现 `needs-input`、`waiting-confirmation`。
- **规则：** `plugins/automation/skills/automations/SKILL.md:40` 明确禁止在普通回复中列出状态代码。

## Root cause

- 次数：模型自行计算（含 / 不含起始日或结束日的差一），而不是引用工具结果中的权威次数；工具结果未提供可直接引用的 `occurrenceCount`，或提供了但 skill 未要求引用。
- 状态码：工具结果把 `needs-input` / `waiting-confirmation` 作为可读文本暴露，模型照抄；SKILL.md 只有禁令没有替换示例。

## What to build

- 预览 / 创建结果中提供与卡片同源的次数字段，SKILL.md 要求回复只引用该字段（或不写次数，指向卡片）。
- SKILL.md 增加 `needs-input` → “还需选择结束日期”、`waiting-confirmation` → “等待在卡上确认”的映射示例；可选在 reply 后处理时检测并告警。

## Acceptance criteria

- [ ] 回复次数与卡片一致（同源计算）。
- [ ] 回复不含 `needs-input` / `waiting-confirmation` / `applied` 等代码。

## Test requirement

- 单测：卡片次数与工具结果次数来自同一函数且相等（含边界日期）；skill 文本测试（若已有 skill lint）覆盖新示例。
