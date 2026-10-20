# Task 9q — P09q 多草稿状态回复泄漏 `applied` 字段与完整 ID

**Status:** todo · bug · P3
**Delivers:** bot 汇报多份草稿状态时只用用户语言，不出现内部字段、布尔值或完整卡片 / 草稿 ID。
**Found in:** 真实飞书测试 bridge，代码 head `b4d67c6`（#52）全量回归
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** 测试群内存在两份待确认草稿（见 P09p 场景），bot 回复两份草稿的状态。
- **期望：** 按 P09f 的 SKILL.md 文案规则，不出现字段名或布尔值；ID 仅在排障时以短形式出现。
- **实际：** 回复写出 “`applied` 为 false”，并列出完整的卡片消息 ID 和草稿 ID。
- **未受影响：** 单结果的标准回复已为自然语言（P09f 修复有效）。
- **严重度：** P3（可在飞书触发；P09f 在多草稿场景回归）。

## Root cause

- automation `SKILL.md` 只覆盖单个结果的措辞；`automation.operation.get` 对草稿返回的 ID 被模型照搬，缺少“多份草稿状态”的指引。

## What to build

- SKILL.md 补充多草稿 / 多结果状态的用户语言示例与禁止项。

## Acceptance criteria

- [ ] 两份待确认草稿的状态回复不含 `applied` 等内部字段，也不含卡片 / 草稿 ID。
- [ ] 在飞书测试群 live 复验。
