# Task 9ax — P09ax 删除 jsonl.ts 中旧版 statusless 完成分支

**Status:** todo · chore · P3（#52 合并后）
**本轮范围（用户 2026-10-21）：** 低优先级，不在 #52 本轮，不交给 Codex；#52 合并后再评估。白话：删除旧版 Grok 兼容代码（做减法），改不改都行。
**Owner:** local Grok Build
**Found in:** P09ao 分诊（wontfix），2026-10-20
**Blocked by:** #52 合并

## Background

P09ao（`src/agent/grok/jsonl.ts:160`）只在省略 `status` 的旧版 Grok 上触发。旧版不受支持，不打补丁，改为做减法：删除对 statusless 工具完成更新的遗留推断分支。

## Acceptance criteria

- [ ] 删除 `jsonl.ts` 中为缺失 `status` 的工具更新推断完成的分支及其专用辅助代码。
- [ ] 当前 Grok（带 `status`）的工具卡与 tool_result 行为不变。

## Test requirement

- 删除仅覆盖 statusless 旧格式的测试；保留并通过带 `status` 的现有 fixture 测试。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
