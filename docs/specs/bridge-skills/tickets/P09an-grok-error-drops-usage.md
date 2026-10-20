# Task 9an — P09an Grok 失败终态丢失已缓存的 usage（token/cost）

**Status:** deferred · bug · P3（仅影响 usage 遥测；#52 合并后跟进）
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（#52 Codex 定向 review，`7514c1e`，已接受）
**Found in:** #52 Codex scoped review，2026-10-20
**Blocked by:** None

## Root cause

`translateError` 与 `fail()` 直接返回 error 事件，从未调用 `takeUsage()`。Grok 先发 `usage` 再发 `error` 时，缓存的 usage 被丢弃，失败运行缺少 token/cost 指标；而正常结束（`translateEnd`）与中断（`finish(reason)`）都会先发出缓存的 usage。

**位置：** `src/agent/grok/jsonl.ts` `translateError`（约 `:222-228`）、`fail()`（约 `:95-101`）

## Repro

JSONL 流：`usage` 事件后接 `error` 事件 → 输出只有 error，没有 usage。`fail()` 路径（如进程异常）同理。

## Acceptance criteria

- [ ] `translateError` 与 `fail()` 在 error 事件之前发出已缓存的 usage（经 `takeUsage()`）。
- [ ] usage 只发一次，不重复；无缓存 usage 时行为不变。

## Test requirement

- 回归测试：`usage` 后接 `error` → usage 事件出现且位于 error 事件之前；`fail()` 路径同样断言。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
