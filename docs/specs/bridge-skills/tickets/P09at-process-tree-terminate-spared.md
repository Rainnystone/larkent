# Task 9at — P09at 继承 stdout 的后代进程在 drain 后未被终止

**Status:** todo · bug · P1
**Owner:** Codex（CLI 无关，邮件交接）
**Audit verdict:** CONFIRMED（#52 Codex 定向 review，`7514c1e`，已接受）
**Found in:** #52 Codex scoped review，2026-10-20
**Blocked by:** None

## Codex finding (verbatim)

> **</sub>  Terminate stdout-inheriting descendants after draining**
> 
> On Linux and macOS, when a detached descendant inherits the CLI's stdout, it is added to `spared` and skipped for both the initial SIGTERM and the later SIGKILL. `stop()` then waits only for the leader, destroys the pipe after the drain window, and returns while the descendant continues running as an orphan; this can leave shell commands active after a user stop or timeout. Preserve output long enough to drain, but ensure every spared PID is subsequently terminated.

**位置：** `src/platform/process-tree.ts:47`

## Fix direction

保留 drain 窗口，但 drain 结束后对所有 spared PID 发 SIGTERM/SIGKILL，`stop()` 返回前确保无遗留。

## Acceptance criteria

- [ ] 保留 drain 窗口，但 drain 结束后对所有 spared PID 发 SIGTERM/SIGKILL，`stop()` 返回前确保无遗留。

## Test requirement

- 回归测试：继承 stdout 的 detached 后代在 stop/超时后被终止（Linux/macOS），输出仍在 drain 窗口内被读取。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
