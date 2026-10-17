# A14 — agent 任务结果帖正文为空（只剩页脚）

Status: ready-for-agent
Severity: **high**（A11 发现：每条 agent 任务结果帖都只有「在本消息话题里追问」）
Blocked by: —（与 A13 并行；A15 的页脚改动在同一函数附近，先合 A14 再做 A15 可少冲突）
Track: 推到现有 code 分支 `feat/automations-v2`（PR #49），不开新 PR
Spec: [../../automations.md](../../automations.md) §4–§5（结果帖），ADR-019

## 现象（真实触发，A11 @ a27e564，Bot Arena，时间 Asia/Shanghai）
- 结果帖 om_…5a3c（03:54）、om_…12ab（03:55）、om_…1fa6（03:55）、om_…6baf（04:00）、om_…643a（04:01）、补跑 om_…dd16（04:29，「（补跑，原定 04:20）」）正文全空，只有页脚「在本消息话题里追问」。
- 会话记录里 agent 都给出了最终答复（例如「AG4 完成，群数=1」），话题追问（04:03 om_…5922）也能续上同一会话——答案生成了，只是没被放进结果帖。

## 根因（已在 a27e564 只读核对）
- `src/automations/agent-run.ts:286-297`：正常结束时 `body = renderText({ ...state, blocks: 非 tool 块 })`。`renderText`（`src/card/text-renderer.ts:15`）只拼 `state.blocks`，不看 `state.finalText`。
- Grok（以及 codex/cursor/kimi/antigravity，metadata 里 `replyMode: 'final-answer'`）把最终答复留在 pending，回合结束时发 `final_text` 事件（`src/agent/grok/jsonl.ts:226`），`reduce` 只写进 `state.finalText`（`src/card/run-state.ts:107`），不产生 text 块。所以 `blocks` 里没有答案 → body 为空 → `formatAgentResultPost`（agent-run.ts:79）只剩页脚。
- 人类路径没有这个问题：`final-answer` agent 用 `finalReplyState(progress, state)`（`src/bot/channel.ts:2368`，调用 :2124、:2200），没有打开进度流时回落到 `finalAnswerOnlyState(state)`（`src/bot/cot.ts:252`）：有 `finalText` 就用它（加上 `outcomeNoticeBlocks` 里的 partial 警告），没有就退回 text 块。`stream-deltas` agent（claude）直接用 `filterForPrefs(state)` 的块。
- 自动化 fire 没有进度流（spec：无 typing/stream/CoT），所以正确的就是「没有进度流」那一支。
- 次要：正文为空且 outcome 为 `completed`/`partial` 时仍然 `setStatus('ok')` 并发出只有页脚的帖（agent-run.ts:295-298）。

## 要做
1. 抽一个共享函数，人类路径和自动化路径都调用它，**不复制逻辑**。例如在 `src/bot/cot.ts`（或新 `src/bot/final-reply.ts`）导出 `finalReplyFor(state, { replyMode, streamed: boolean })`：
   - `replyMode === 'final-answer'`：`streamed` 为真时就是现在 `finalReplyState` 已打开进度流那一支（只留 `finalText`）；否则 `finalAnswerOnlyState(state)`。
   - `stream-deltas`：返回原 state（调用方照旧做 `filterForPrefs`）。
   - `channel.ts` 的私有 `finalReplyState` 和 `finalAnswerOnly` 判断改为调用它；`agent-run.ts` 用 `descriptorFor(runtime.profileConfig.agentKind).replyMode` + `streamed:false` 调用它，再过滤 tool 块、`renderText`。
   - 不要在 agent-run 里另写一个「`finalText ?? blocks`」。
2. 正文仍为空（agent 真的什么都没说）时，不发只有页脚的帖：发「任务已完成，agent 没有给出文字结果。」+ 页脚（追问仍有意义：会话在）。`lastStatus` 仍为 `ok`。
3. 失败/中断分支（`formatAgentFailureBody`）不在本票改动范围；页脚规则见 A15。

## 验收
- [ ] 单测（fixture 来自 Grok 事件形状）：事件流只有 `system` → `tool_use`/`tool_result` → `final_text("AG4 完成，群数=1")` → `done`，**没有任何 text delta**；结果帖正文含「AG4 完成，群数=1」，并且只出现一次。
- [ ] 单测：同一 fixture 分别喂给人类路径的无进度流分支和自动化路径，断言两边正文字符串相等；若 fire 路径会产生 `outcomeNoticeBlocks` 那类 partial 警告，正文 = finalText + 警告，与人类路径一致。
- [ ] 单测：claude（`stream-deltas`）只有 text 块时，结果帖正文 = text 块，行为不变。
- [ ] 单测：补跑 fire 正文在前、「（补跑，原定 HH:MM）」、页脚在后。
- [ ] 单测：agent 什么都没输出 → 帖子是「任务已完成，agent 没有给出文字结果。」+ 页脚，不是只有页脚。
- [ ] `rg "finalText" src/automations` 只出现在调用共享函数处（没有第二套提取逻辑）；人类路径现有回复测试全绿。
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。
- [ ] Bot Arena 实测：一次准点 agent fire、一次补跑 agent fire，结果帖都带 agent 的真实答复。

## A11 需重跑的场景
A8 agent 任务 fire → 结果帖 → 话题追问；A8/ADR-019 补跑 agent fire（「补跑，原定 HH:MM」+ 正文）；A9 允许路径（AG4 bot 自发消息 + 结果帖正文）。
