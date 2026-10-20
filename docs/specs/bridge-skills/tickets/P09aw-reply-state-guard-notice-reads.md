# Task 9aw — P09aw `notice()`/`supersededByThisTurn()` 回执读取未防护

**Status:** deferred · bug · P3
**Owner:** Codex（CLI 无关，邮件交接）
**Audit verdict:** CONFIRMED（#52 Codex 定向 review，`7514c1e`，已接受）
**Found in:** #52 Codex scoped review，2026-10-20
**Blocked by:** None
**Deferred reason:** 需要持久化在同一轮中途失败才能触发。（2026-10-20 实测分诊，本轮不修）

## Codex finding (verbatim)

> **Guard receipt reads while composing the final notice**
> 
> If one waiting receipt is tracked successfully and a later automation write in the same turn makes the persistence queue unhealthy, `noteResult` now swallows its receipt-read failure but `notice()` calls `getOperation` without protection. `AutomationsStore.assertMutable()` then rethrows during final reply rendering, so the bot can lose its response even though the earlier confirmation card was delivered; apply the same defensive read handling throughout `notice()` and `supersededByThisTurn()`.

**位置：** `src/automations/reply-state.ts:30`

## Fix direction

在 `notice()` 与 `supersededByThisTurn()` 中对 `getOperation` 采用与 `noteResult` 相同的防御性读取（捕获并降级）。

## Acceptance criteria

- [ ] 在 `notice()` 与 `supersededByThisTurn()` 中对 `getOperation` 采用与 `noteResult` 相同的防御性读取（捕获并降级）。

## Test requirement

- 回归测试：持久化队列变为 unhealthy 后，`notice()`/`supersededByThisTurn()` 不抛错，最终回复仍渲染。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
