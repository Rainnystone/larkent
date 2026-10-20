# Task 9g — P09g 替换确认卡“将删除”文案易误解

**Status:** done · fixed in #52 by b79a9fc（2026-10-20） · bug · P3
**Delivers:** 替换确认卡明确表达“用新设置替换 #N（确认后编号变为新号）”，不让用户以为任务将被删掉。
**Found in:** [P09](P09-real-feishu-acceptance.md) 续会话替换，候选版本 `0b55865`（Antigravity、Cursor、Kimi 均出现）
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** 续会话把 #1 的时间从 10:00 改为 11:00，bridge 发替换确认卡。
- **期望：** 卡片明确说明“替换 #1”。
- **实际：** 卡头“确认替换 #1”，正文第一行却是“将删除：#1 …”，容易被理解为删除任务。确认后旧 #1 消失、新建 #2（编号变化属于设计），只是文案未说明。
- **严重度：** P3（文案）。

## Evidence

- P09 三个 CLI 的替换确认卡回读（盒子本地 P09 证据目录，read-C*.json 与对应 profile 的回读）。

## Root cause（`0b55865`）

- `src/automations/confirm-card.ts:243` `automationReplaceCard`：`removed` 行固定为 `将删除：#${id} …`。

## What to build

- 正文首行改为“替换：#N <名称> · <原排期> → 新设置如下”一类表述，并说明“确认后原 #N 将由新编号取代”。
- 保留原排期信息以便对照；卡头不变。

## Acceptance criteria

- [ ] `tests/unit/automations/confirm-card.test.ts` 替换卡用例更新：正文不含“将删除”，含“替换”、原排期与编号变化说明。
- [ ] 已解决卡（“已替换 #1 → #2”）不受影响。
- [ ] `pnpm ci:local` 通过。
