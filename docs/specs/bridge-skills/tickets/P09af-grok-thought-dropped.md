# Task 9af — P09af Grok `thought` 被丢弃：CoT 为空，idle 计时视为静默

**Status:** todo · bug · P2
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（Grok Build 只读审计 G6，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

translator 的 `thought` 分支返回 `[]`，从不产出 `thinking`；也不触发 watchdog `noteDelivered`。长时间无工具的思考期被视为静默（默认 15 分钟），叠加 P09aa 丢答案。

**位置：** `src/agent/grok/jsonl.ts:50-51`；`src/bot/cot.ts`；`src/bot/idle-watchdog.ts`

## Repro

解析 `s2-clean-color-env.jsonl`：`thought` 行 3 条，translator `thinking` 事件 0 条。

## Acceptance criteria

- [ ] `thought` 按序映射为 `thinking` delta，在 CoT 与 reasoning 面板各出现一次，不混入最终答案。
- [ ] `thought` 行重置 idle watchdog。

## Test requirement

- s2 fixture：断言 3 个 thought 块产出有序 `thinking` 事件且只出现一次；断言 thought 行重置 watchdog。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
