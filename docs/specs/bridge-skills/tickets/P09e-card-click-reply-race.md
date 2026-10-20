# Task 9e — P09e 点卡早于最终回复时，回复仍写“待确认”

**Status:** done · fixed in #52 by 5f4385b, e31a84e（2026-10-20） · bug · P3
**Delivers:** 用户在模型最后一次工具调用之后、最终回复发出之前点击确认卡时，最终回复不再与卡片的实际状态矛盾。
**Found in:** [P09](P09-real-feishu-acceptance.md) 真实飞书 E2E，候选版本 `0b55865`（Cursor、Kimi 各一次）
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** 续会话替换任务（10:00 → 11:00）；模型调用 `automation.replace` 得到 `waiting-confirmation` 后开始生成回复，用户在回复发出前点击「是」。
- **期望：** D7“卡片、状态回复和工具结果引用同一实际状态”——回复不应声称仍待确认。
- **实际：** 卡片已更新为“已替换 #1 → #2”，随后 1–4 秒发出的最终回复仍写“待确认／确认前仍按原来的 10:00 执行”。回复是模型在工具结果时刻的快照；不是反问，也不需要用户补信息。
- **严重度：** P3（竞态窗口仅数秒，卡片本身正确）。

## Evidence

- P09 证据目录 `read-cursor-2.json`、`read-kimi-2.json`（卡片已替换与随后回复的时间与内容）；对应 profile jsonl 中 replaced 事件时间早于最终回复发送时间。

## Root cause（`0b55865`）

- 最终回复由 `src/bot/channel.ts:2321-2325` `deliverFinalReply({ state: finalReplyFor(filterForPrefs(finalState), …) })` 发送，内容只来自模型文本，发送前不核对本轮工具结果引用的草稿/operation 当前状态。
- 卡片点击由 `src/card/dispatcher.ts:414` 起的路径独立处理并更新卡片（`src/automations/draft-card.ts:26` “已替换 #… → #…”），与 run 的最终回复没有关联。

## What to build

- run 记录本轮 `waiting-confirmation` 结果对应的 draftId/operationId。
- 发送最终回复前查询这些草稿/operation 的实际状态；若已离开待确认（已确认、已拒绝、已失效），在回复末尾追加一行由代码生成的状态说明，文案与卡片的已解决标题一致（例如“（回复生成期间已确认：已替换 #1 → #2）”）。不改写模型正文。
- 回复已发出后才点击的情况不处理（卡片本身即为状态来源）。

## Acceptance criteria

- [ ] T1 业务链（固定时钟/可控事件顺序）：tool_result=waiting-confirmation → 卡片确认 → 最终回复发送；回复包含与卡片一致的状态说明行。修复前失败。
- [ ] 对照：最终回复发出前未点击 → 回复无追加行；拒绝（「否」）→ 追加行说明已取消。
- [ ] 一轮多张卡时只为已变化的草稿追加说明。
- [ ] `pnpm ci:local` 通过。
- [ ] P09 重跑：在回复生成期间点击替换卡，回复与卡片状态一致。

## Non-goals

- 在回复发出后再编辑或补发消息。
