# Task 9z — P09z（deferred）Codex review #1 setImmediate 结算窗口 与 #3 去重指纹不含 actor

**Status:** deferred · P3
**本轮范围（用户 2026-10-21）：** 低优先级，不在 #52 本轮，不交给 Codex；#52 合并后再评估。白话：Codex 早期审查留下的两个理论边缘情况（点卡极短时间窗口；去重不区分点击者）。
**Owner:** Cursor Project
**Delivers:** 记录两条 review 发现的风险评估；本轮不修。
**Found in:** #52 Codex review，2026-10-20 live 证据评估
**Worker class:** judgment
**Blocked by:** None

## Finding #1：`scheduleDraftCardSettle` 的 `setImmediate` 结算窗口

- `src/automations/draft-card.ts:93`：卡片结算在 `setImmediate` 中异步执行，确认与卡片更新之间存在短窗口。
- **证据：** 确认在 store 中按 operation 状态与 nonce（`claimNonce`/`consume`，`dispatcher.ts:478-482`）判定，窗口内的二次点击被 nonce/operation 状态拒绝；本轮 live 的重复（#18/#19）来自两个不同 operation（不同指纹、不同排期），并非同一卡片在窗口内被二次确认。
- **结论：** 不产生重复；只影响卡片显示时机（与 P09y 的可见性问题相关）。

## Finding #3：去重指纹不含 actor

- `src/automations/operation.ts:69`：fingerprint 由 taskType、cwd、name、taskText、timezone、schedule 构成，不含 `createdBy`。
- **证据：** 指纹仅用于同 profile + 同群的 operation 复用（`findReusableOperation`）；草稿确认仍按卡片 actor 鉴权。本轮所有 operation 为同一 actor，#18/#19 指纹不同，重复与该发现无关。不同 actor 发起相同请求时只会复用同一待确认 operation，不会多建任务。
- **结论：** 不产生重复；理论上影响“谁的草稿”归属展示。若 P09v 引入按 actor 自动取代，需同时把 actor 纳入指纹。

## Acceptance criteria（启用时）

- [ ] #1：结算失败可观测（与 P09y 日志一起）。
- [ ] #3：指纹包含 actor，跨 actor 不复用。

## Test requirement（启用时）

- 跨 actor 相同请求生成不同 operation 的单测。
