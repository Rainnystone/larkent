# Task 09bc — P09bc SIGKILL 升级跳过持有 stdout 的进程，run 可能永不结束

**Status:** fixed in code · fixed in #52 by 2e64fa0, 0aea2d7；CI green @0aea2d7，live FX-bc re-verify pending（2026-10-21） · test/bug
**Owner:** Codex
**Follow-up of:** [P09ai](P09ai-stop-leaves-grandchildren.md)（修复提交 `820d0af`、`527fc2d`、`7514c1e`）；关联 [P09at](P09at-process-tree-terminate-spared.md)
**Blocked by:** P09aq（同文件；待 P09aq 绿后一批交接）
**Evidence:** 代码阅读 `7514c1e` 对比 merge-base `953e7bd`；**未 live 验证**（box PATH 上无各 CLI）。

## Root cause

`process-tree.ts` 改为进程组信号（保留）；但被豁免的 stdout 管道持有者在 SIGKILL 升级时同样被跳过。

## Real-use impact

孙进程忽略 SIGTERM 且持有 stdout 时，管道不关闭，run 可能永不结束；进程泄漏。

## Fix

先补测试；失败则让 SIGKILL 升级覆盖全部组成员（含 spared）。

## Acceptance criteria

- [ ] 停止后 run 在 kill grace 内结束。
- [ ] 停止后进程组内无残留成员。

## Required tests

- fixture：孙进程忽略 SIGTERM 并持有 stdout 管道；断言 run 在 kill grace 内结束、组内无存活成员（Linux/macOS；Windows 走对应树终止路径）。
