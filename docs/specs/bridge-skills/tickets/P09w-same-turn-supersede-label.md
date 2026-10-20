# Task 9w — P09w 同一轮内被取代的草稿被标为「回复生成期间已失效」

**Status:** todo · bug · P3
**Owner:** Cursor Project
**Delivers:** 同一轮回复中由模型自己取代的草稿不再显示“回复生成期间已失效”提示。
**Found in:** 真实飞书测试 bridge，代码 head `6dd0e44`（#52），2026-10-20 live 回归
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** 一轮内模型先创建草稿 A，再以 `supersedesOperationId=A` 创建 B（18:14 回合：op `…b421036e` 被 `…86f33839` 取代）。
- **实际：** 最终回复追加「（回复生成期间已失效：…）」，暗示是用户/外部操作导致失效。
- **期望：** 本轮自身取代的草稿不追加该提示（或改为“已用新卡取代”）。

## Root cause

- `src/automations/reply-state.ts:23-25`：`notice()` 只看 `operation.code === 'draft-superseded'`，不区分取代者是否为本轮自己创建的 operation。

## What to build

- 在 waiting 集合中记录本轮创建的 operationId；若取代者（新 op 的 `supersedesOperationId` 指向它）属于本轮，跳过该提示。

## Acceptance criteria

- [ ] 同轮取代：不出现「回复生成期间已失效」。
- [ ] 外部取代（另一轮 / 用户点击）：仍出现提示。

## Test requirement

- `reply-state` 单测覆盖同轮取代与跨轮取代两种情况。
