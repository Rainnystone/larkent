# Task 9av — P09av 同名时间戳取自暂停/恢复等管理回执

**Status:** deferred · bug · P3
**Owner:** Codex（CLI 无关，邮件交接）
**Audit verdict:** CONFIRMED（#52 Codex 定向 review，`7514c1e`，已接受）
**Found in:** #52 Codex scoped review，2026-10-20
**Blocked by:** None
**Deferred reason:** 需要人为构造的操作顺序才能触发。（2026-10-20 实测分诊，本轮不修）

## Codex finding (verbatim)

> **Restrict same-name timestamps to task-creating operations**
> 
> When an existing same-name task was created through the manual command path, then a second independent same-name draft is opened and the existing task is paused or resumed through the tool before that draft is confirmed, the management operation becomes an applied receipt linked to the old task. This helper treats that later mutation timestamp as the task's creation time, so `findSameNameCreateConflict` rejects the otherwise permitted second task; only receipts that actually created or replaced the task should establish this timestamp.

**位置：** `src/automations/store.ts:619`

## Fix direction

只有实际创建或替换任务的回执（create/replace）确定同名时间戳；pause/resume 等管理操作不计入。

## Acceptance criteria

- [ ] 只有实际创建或替换任务的回执（create/replace）确定同名时间戳；pause/resume 等管理操作不计入。

## Test requirement

- 回归测试：手动创建的同名任务经工具 pause/resume 后，第二个独立同名草稿确认不被 `findSameNameCreateConflict` 拒绝；create/replace 冲突检测保持不变。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
