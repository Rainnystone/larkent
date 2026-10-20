# Task 9n — P09n 最终渲染后、回复记账期间确认卡结算，结算提示只写入 journal、未补到已流式消息

**Status:** deferred · bug · P3（不进 #52）
**本轮范围（用户 2026-10-21）：** 低优先级，不在 #52 本轮，不交给 Codex；#52 合并后再评估。白话：回复发完后才点确认卡时，“已确认”提示只进内部日志，没补到群消息上。
**Delivers:** 确认卡在流式最终渲染之后、`deliverFinalReply` 最终检查之前结算时，结算提示行同样补到已发出的流式消息上，使 journal 文本与屏幕一致。
**Found in:** #52 Codex review 第 3 轮 P2（`src/bot/channel.ts:2623`），triage 为 P3 deferred
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** 回复流式输出，最终渲染已完成；在随后的回复记账阶段（从最后一次渲染到 `deliverFinalReply` 里的最终检查，窗口约几百毫秒到 2 秒）用户点击确认卡，卡片结算。
- **期望：** 结算提示行与 journal 一致地出现在已流式发出的消息上。
- **实际：** 结算提示行只在 journal 中重新暂存（restage），从未 patch 到已流式发出的消息；确认卡本身显示正确状态。
- **严重度：** P3（纯外观：journal 文本与屏幕不一致，只有从 journal 重发时才会体现）。

## Root cause

- `src/bot/channel.ts:2623` 附近：最终检查发现结算后只更新 journal 暂存内容，此时流式消息已完成最终渲染，没有再次 patch 的路径。

## What to build

- 最终检查命中“渲染后结算”时，对已流式消息补一次 patch（或改为在最终渲染前完成结算检查），保持 journal 与屏幕一致；不改变卡片本身的结算逻辑。

## Acceptance criteria

- [ ] channel 测试：在最终渲染后、最终检查前结算确认卡，已流式消息与 journal 都含结算提示行。
- [ ] `pnpm ci:local` 通过。
