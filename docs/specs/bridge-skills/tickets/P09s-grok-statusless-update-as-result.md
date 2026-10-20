# Task 9s — P09s Grok 无 status 的 tool_call_update 被当作工具结果，shell 退出码被忽略

**Status:** todo · bug · P2 · reopens P09o
**Owner:** local Grok Build
**Delivers:** Grok shell 非 0 退出码在工具卡显示为失败；无 status 的中间更新不再结束工具调用。
**Found in:** 真实飞书测试 bridge，代码 head `6dd0e44`（#52），2026-10-20 live 回归
**Worker class:** judgment
**Blocked by:** None

## Bug

- **场景（RT-O1）：** 让 agent 运行 `ls /nonexistent-p09-retest-path`。
- **期望：** 工具卡显示失败（❌），CoT 显示错误输出。
- **实际：** 工具卡显示 ✅；退出码 2 被忽略。
- **严重度：** P2（失败命令被报告为成功，误导用户）。

## 真实事件形状（Grok 1.0.41，ID 已脱敏，字节数组已截断）

同一 `toolCallId` 依次收到 3 条：

1. `tool_call`（`title: "run_terminal_command"`，无 status）
2. `tool_call_update`（含 `kind: "execute"`、`title`、`rawInput`，**没有 `status` 字段**，`_meta.updateParams.status: null`，无 `rawOutput`）
3. `tool_call_update`（`status: "completed"`，`rawOutput: {"type":"Bash","output":[字节数组],"exit_code":2,...}`）

完整样本：`/workspace/p09-evidence/grok-raw-samples.jsonl`（本地，`sample: "P09s"`）。

## Root cause

- `src/agent/grok/jsonl.ts:139-146` `translateToolCallUpdate` 把 `status === undefined` 与 `completed` 同等处理，第 2 条无 status 的元数据更新即调用 `toolResult`。
- `toolResult`（`jsonl.ts:150-170`）随即 `startedToolCalls.delete(id)`，并发出 `output: ''`、`isError: false` 的结果；第 3 条真正的 completed 更新到来时工具名已丢失，`isShellTool(undefined)` 为假，`exit_code: 2` 被忽略（并记一次 drift anomaly）。

## What to build

- 无 `status` 的 `tool_call_update` 视为进度/元数据更新：不发 tool_result，不删除 `startedToolCalls`；如带有更具体的 `kind`/`title`/`rawInput` 可更新已记录的工具信息。
- 仅在 `completed`/`failed`/`error` 时结束工具调用，并用保留的工具名判断 shell 退出码（`exit_code`/`exitCode`）。
- 若某真实 Grok 版本确实只用无 status 更新携带最终结果（有 `rawOutput`），需保持兼容：仅当无 status 且带 `rawOutput` 时才当作结果。

## Acceptance criteria

- [ ] 上述 3 事件序列只产生 1 个 tool_result，`isError: true`，输出含 `ls: cannot access`。
- [ ] 非 shell 工具（如 grep `exit_code: 1`）不因退出码判失败（保持 `b4d67c6` 行为）。
- [ ] 不计入 drift anomaly。
- [ ] 飞书测试群 live 复验 RT-O1 显示失败。

## Test requirement

- 在 `tests/` 的 Grok jsonl 解析测试中加入由上面真实事件形状构造的回归用例（先失败后通过）：shell exit 2 → isError；无 status 更新不产生结果；grep exit 1 仍为成功。
