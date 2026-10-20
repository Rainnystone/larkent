# Task 9v — P09v 模型修订未确认草稿时未传 supersedesOperationId，旧卡仍有效并产生重复任务

**Status:** done · fixed in #52 by 93a6c75, 9d38691（2026-10-20） · bug · P2
**Owner:** Cursor Project
**Delivers:** 修订未确认草稿时，即使模型忘记传 `supersedesOperationId`，旧草稿也会失效，不会产生重复任务。
**Found in:** 真实飞书测试 bridge，代码 head `6dd0e44`（#52），2026-10-20 live 回归
**Worker class:** judgment
**Blocked by:** None

## Bug（STEP 1 live 证据，ID 已脱敏，时间 UTC+8）

- 18:11:44 用户要求每日 09:00 提醒 `P09RT每日回归`；18:12:07 生成草稿（op `…a9cf0c79`，无结束日期 → 结束日期卡）。
- 18:12:32 用户要求改为 08:45；模型生成 op `…b421036e`（18:13:07，后被取代），18:14:25 再生成 op `…86f33839`（18:14:54，`supersedesOperationId` 指向 `…b421036e`）。**两次都没有取代 09:00 的 op `…a9cf0c79`**。
- 18:18 用户在 08:45 卡上点「是」→ `auto confirmed id=18`（18:18:27.388）；随后在仍然有效的 09:00 结束日期卡上选「一周」，确认卡显示 共 6 次，点「是」→ `auto confirmed id=19`（18:18:28.934）。
- 结果：automations 中同名 `P09RT每日回归` 两个任务：#18 每日 08:45（至 2026-11-20），#19 每日 09:00（至 2026-10-27）。**重复存在**，没有任何守卫拦截。

```
{"ts":"2026-10-20T18:18:27.388+08:00","phase":"auto","event":"confirmed","chatId":"oc_<redacted>","msgId":"om_<A>","traceId":"ebqhvq0e","id":18,"taskType":"reminder"}
{"ts":"2026-10-20T18:18:28.934+08:00","phase":"auto","event":"confirmed","chatId":"oc_<redacted>","msgId":"om_<B>","traceId":"lfmdy75h","id":19,"taskType":"reminder"}
operations: …a9cf0c79 state=applied taskId=19 | …b421036e state=not-applied code=draft-superseded | …86f33839 supersedesOperationId=…b421036e state=applied taskId=18
```

## Root cause

- 取代完全依赖模型在 `automation.create` 中传 `supersedesOperationId`（`src/automations/operation.ts` 约 69-95 行）；模型修订时只取代了它记得的最近一份草稿。
- `confirmCreateDraft`（`src/automations/command.ts:1018-1042`）确认时不检查同群同名的已存在任务 / 其他待确认草稿。

## What to build（不能只依赖模型）

- 创建草稿时自动取代：同 profile、同群、同 actor（`createdBy`）、同名（trim 后）的待确认 create 草稿自动标记 `draft-superseded` 并刷新旧卡为已取代。
- 和 / 或确认时硬去重：确认 create 草稿时若同群已存在同名、同 actor、由本轮修订链产生的任务，拒绝并返回明确 toast（「已有同名任务 #N，此确认已失效」）。
- 保留合法的“同名不同任务”场景：需要用户显式确认才能并存（在 ticket 实现中说明取舍）。

## Acceptance criteria

- [ ] 复现上述序列（09:00 草稿 → 改 08:45 且不传 supersedesOperationId → 两卡都确认）最终只有 1 个任务。
- [ ] 旧卡点击返回失效 toast，卡片显示已取代。
- [ ] 其他 actor 或其他群的同名草稿不受影响。
- [ ] 飞书测试群 live 复验。

## Test requirement

- automations 单测：无 `supersedesOperationId` 的同名修订自动取代旧草稿；旧草稿确认被拒；跨 actor 不取代。
