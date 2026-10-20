# Task 9ai — P09ai 停止只信号 grok pid，孙进程（shell 工具）存活

**Status:** todo · bug · P2
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（Grok Build 只读审计 G9，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

子进程 `detached: true` 是进程组 leader，但 `stopChild` 只对 pid 发 `SIGTERM/SIGKILL`，不发进程组；仅 turn-journal 的 `reapOrphan` 用 `kill(-pid)`。

**位置：** `src/agent/runner/jsonl-cli-runner.ts:83`、`:206`、`:216`；`src/bot/turn-journal.ts`（reapOrphan）

## Repro

detached Node 父进程 spawn `sleep 20`，对父 pid 发 SIGTERM：`{"parentAlive":false,"grandAlive":true}`。

## Acceptance criteria

- [ ] user stop / idle stop 对整个进程组发信号（`process.kill(-pid, …)`，失败回退单 pid）。

## Test requirement

- fixture CLI 启动 `sleep`，`run.stop()` 后宽限期结束断言 sleep pid 已不存在。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
