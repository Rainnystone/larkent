# Task 09ay — P09ay 收窄停止后 final_text 放行（共享闸门过宽）

**Status:** todo · bug · P1（#52）
**Owner:** Codex
**Follow-up of:** [P09aa](P09aa-grok-stop-drops-final-text.md)（修复提交 `4556ad8`、`0b7009f`）
**Blocked by:** P09aq（同文件；待 P09aq 绿后一批交接）
**Evidence:** 代码阅读 `7514c1e` 对比 merge-base `953e7bd`；**未 live 验证**（box PATH 上无各 CLI）。

## Root cause

`src/bot/run-outcome.ts` `shouldDeliverAgentEvent`（约 :98）被改为停止后对**所有 CLI、所有停止原因**放行 `final_text`。注释称 Claude/Codex 以 `text` 流式输出答案，对 Codex 不成立：Codex（`src/agent/codex/jsonl.ts:55-70`）、Kimi（:60-75）、Cursor（:78-93）、Antigravity（:159、:287）中断时都会把暂存的最终消息作为 `final_text` 发出。

## Real-use impact

- policy-guard 停止（`7b477d4`）可能把正被拦截的文本发到群里。
- 会议停止、订阅者放弃（subscriber-abandoned）停止也会发帖。

## Fix

不放宽共享闸门。二选一：(a) 仅对用户主动停止放行 `final_text`；或 (b) Grok translator 在 `done` 之前 flush 暂存文本，并把共享闸门恢复到 `953e7bd` 行为。修正错误注释。

## Acceptance criteria

- [ ] policy-guard / 会议 / subscriber-abandoned 停止：任何 CLI 都不发出 `final_text`。
- [ ] 用户停止：暂存答案恰好发出一次（Grok 与 Codex）。
- [ ] 注释与各 adapter 实际行为一致。

## Required tests

- 表驱动：StopRequest 类型 × {grok, codex}；policy-guard 不发文本；用户停止恰好一次。
- 覆盖调用方 `src/bot/channel.ts:3130` 与 `src/automations/agent-run.ts:510`，不只测辅助函数。
