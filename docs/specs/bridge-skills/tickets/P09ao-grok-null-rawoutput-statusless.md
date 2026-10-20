# Task 9ao — P09ao statusless 完成更新中 `rawOutput: null` 未产生 tool_result

**Status:** deferred · bug · P3
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（#52 Codex 定向 review，`7514c1e`，已接受）
**Found in:** #52 Codex scoped review，2026-10-20
**Blocked by:** None
**Deferred reason:** 仅旧版 Grok（省略 status）触发；box 上 Grok 为当前版本。（2026-10-20 实测分诊，本轮不修）

## Codex finding (verbatim)

> **Accept null output on statusless completed tool updates**
> 
> On older Grok streams that omit `status`, a tool that legitimately completes with `rawOutput: null` has an explicit result carrier but fails the `!= null` test. No `tool_result` is emitted and the call remains in `startedToolCalls`, which can leave the UI showing an in-flight tool and extend the idle watchdog to the one-hour tool window; distinguish presence of the `rawOutput` property from its value.

**位置：** `src/agent/grok/jsonl.ts:160`

## Fix direction

以 `rawOutput` 属性是否存在（`'rawOutput' in update` / `hasOwnProperty`）判断结果载体，而非 `!= null`；发出 tool_result 并移出 `startedToolCalls`。

## Acceptance criteria

- [ ] 以 `rawOutput` 属性是否存在（`'rawOutput' in update` / `hasOwnProperty`）判断结果载体，而非 `!= null`；发出 tool_result 并移出 `startedToolCalls`。

## Test requirement

- 回归测试：statusless 更新带 `rawOutput: null` → 发出一次 tool_result，调用不再处于 started；无 `rawOutput` 属性时行为不变。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
