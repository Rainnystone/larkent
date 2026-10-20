# Task 9y — P09y 确认成功但卡片转圈后复原、无 toast

**Status:** todo · bug · P3 (UX)
**Owner:** Cursor Project
**Delivers:** 确认卡点「是」后，用户一定能看到结果（toast 或卡片状态更新）。
**Found in:** 真实飞书测试 bridge，代码 head `6dd0e44`（#52），2026-10-20 live 回归
**Worker class:** judgment
**Blocked by:** None

## Bug

- **场景：** 18:18 在 09:00 确认卡（共 6 次）点「是」，紧接在另一张卡（#18）确认之后约 1.5 秒。
- **实际：** 按钮转圈后复原，无 toast，卡片未变为已确认；但 bridge 实际已创建任务：`auto confirmed id=19`（18:18:28.934，trace `lfmdy75h`）。该 trace 之后没有任何卡片结算 / board.patch 日志，board.patch 只出现在 #18 的 trace 上。
- **结论：** 不是错误、不是 `skip-auto-unregistered`，也不是去重守卫拒绝——是“成功但用户看不到成功”。用户因此以为没生效（与 P09v 叠加时更易造成重复）。

## Root cause（推测，需实现者确认）

- `src/card/dispatcher.ts:477-485`：确认路径先 `await confirmAutomationDraft`（含 store 写入与 `onAutomationConfirmed` 板更新），再返回 toast；与并发的 #18 确认竞争 board 锁时总耗时可能超过飞书卡片回调的响应窗口，客户端放弃 toast。
- 卡片结算 `scheduleDraftCardSettle`（`src/automations/draft-card.ts:93`，`setImmediate`）对 #19 无日志，需确认是否失败被吞。
- 卡片动作入口没有 `cardAction received/responded` 日志，无法测量回调耗时。

## What to build

- 为卡片动作加入口 / 出口日志（含耗时，ID 脱敏），结算失败记 warn。
- 确认路径在回调窗口内返回：把 board 刷新等慢操作移出 await 关键路径（仍保证结算卡片更新最终发生）。

## Acceptance criteria

- [ ] 两张卡 2 秒内连续确认，两张都显示 toast 且卡片变为已确认。
- [ ] 日志可见每次卡片动作的耗时与结算结果。

## Test requirement

- dispatcher 单测：`onAutomationConfirmed` 慢（例如 5s）时确认响应仍立即返回 success toast，结算仍执行。
