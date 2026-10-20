# Task 9a — P09a 周期任务确认卡次数文案错误

**Status:** done · fixed in #52 by 6ea64b9, b42504f（2026-10-19） · bug · P2
**Delivers:** 周期 automation 确认卡展示的触发次数与实际排期一致；有结束时间时显示精确的“共 N 次”。
**Found in:** [P09](P09-real-feishu-acceptance.md) 真实飞书 E2E，候选版本 `0b55865`
**Worker class:** mechanical

## Bug

每天 09:00、开始 2026-10-22、结束 = 开始 + 1 个月（2026-11-22，不含）的提醒，确认卡显示“约每月 28 次”；实际窗口 [startAt, endAt) 内触发 31 次。存储的排期正确，只有确认卡文案/估算错误。

- **影响：** 真实使用中每张周期确认卡都会出现，用户据此决定是否确认，误导触发次数。
- **严重度：** P2（不影响执行正确性，但影响确认决策）。

## Root cause（`0b55865`）

- `src/automations/confirm-card.ts:85,97-100` `frequencyLine`：仅当 `endAt - now < 30 天`（`SHORT_HORIZON_MS`）才计算精确次数；一个月窗口（31 天）超过阈值，落入 `约每月 ${monthlyFireCount(schedule, now)} 次`。
- `src/automations/schedule.ts:488-500` `monthlyFireCount`：固定 30 天窗口（`MONTH_WINDOW_MS`），且从 `now` 而不是 `startAt` 起算。复现时 now≈10-19，窗口约到 11-18，开始前的 3 天被白白计入窗口，只数到 10-22…11-18 共 28 次。
- 两个固定 30 天常量同时决定“是否精确”和“月估算窗口”，与月份长度、开始时间都无关。

## What to build

- 已知 `endAt`：始终显示 [startAt, endAt) 内的精确触发次数 `共 N 次`，从排期本身计算（复用 `nextFireAfter` 迭代，从 `max(now, startAt)` 前一刻开始），不再用 30 天阈值分支。次数很大时设置上限并合理展示（例如超过上限显示“超过 N 次”或附加“约每月 M 次”），避免无界循环。
- 未知 `endAt`（若 schedule 允许）：显示正确的月估算，窗口从 `max(now, startAt)` 起算一个日历月（时区感知），而非从 `now` 起算的固定 30 天。
- 一次性任务文案不变。

## Acceptance criteria

- [ ] 复现用例（每天 09:00，2026-10-22 → 2026-11-22 不含，Asia/Shanghai）确认卡显示 `共 31 次`。
- [ ] 单测覆盖：daily、weekday、weekly、interval 带窗口；`startAt` 晚于 now；28/29/30/31 天月份边界；endAt 恰好落在触发时刻（不含）；大次数上限展示。
- [ ] 现有 `tests/unit/automations/confirm-card.test.ts` 及确认卡相关集成测试更新并通过。
- [ ] P09 重跑中回归该用例，确认卡次数与看板/实际触发一致。

## Non-goals

- **暂停/恢复后 revision 出现 ABA：** won't-fix。内容完全相同，无副作用。
- **结束日期预设最短为“一个月”：** P3，见 [P09i](P09i-end-date-presets.md)；用户可用自然语言指定更短的结束时间。
