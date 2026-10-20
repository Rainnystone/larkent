# Task 9aa — P09aa 停止/空闲超时时 Grok 的暂存答案被丢弃

**Status:** todo · bug · P1
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（Grok Build 只读审计 G1，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

Grok `text` 块暂存在 `pendingText`，只在 `end` 或 `finish('interrupted')` 时产出 `final_text`。停止流程先置 `handle.interrupted`，`shouldDeliverAgentEvent` 只放行 `system/done/error`，`final_text` 被丢弃。首个 `tool_call` 还会清空 `pendingText`，工具前的文字丢失。

**位置：** `src/agent/grok/jsonl.ts:52-56`、`:87`、`:247-252`；`src/bot/run-outcome.ts:86-93`；`src/bot/channel.ts:~3118`（idle watchdog）；`src/automations/agent-run.ts:~497`

## Repro

向 `GrokJsonlTranslator` 送 `{type:"text",data:"answer before stop"}`，调用 `finish("interrupted")`，再对得到的 `final_text` 调用 `shouldDeliverAgentEvent({interrupted:true, stopRequest:{type:"user-stop"}}, ev)` → `false`。

## Acceptance criteria

- [ ] 用户停止、idle watchdog 停止后，已暂存的 Grok 文本作为最终答案送达卡片。
- [ ] 工具调用前的文字不再被静默清空（按段输出或保留）。
- [ ] Claude/Codex 的已流式文本不重复送达。

## Test requirement

- Grok JSONL fixture：若干 text 块、无 `end`；按 idle watchdog 方式停止 → 断言卡片 state 最终答案含该文本；user-stop 同样断言。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
