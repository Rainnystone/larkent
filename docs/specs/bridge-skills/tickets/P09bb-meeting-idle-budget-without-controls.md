# Task 09bb — P09bb 会议在缺少 controls.cfg 时仍须有 idle 预算

**Status:** done · fixed in #52 by 8949a2d（2026-10-20） · test
**Owner:** Codex
**Follow-up of:** [P09ah](P09ah-meeting-no-idle-watchdog.md)（修复提交 `74f31ec`）
**Blocked by:** P09aq（同文件；待 P09aq 绿后一批交接）
**Evidence:** 代码阅读 `7514c1e` 对比 merge-base `953e7bd`；**未 live 验证**（box PATH 上无各 CLI）。

## Root cause

master 上会议 orchestrator 对任何 CLI 都无超时；`74f31ec` 复用 `createIdleWatchdog`/`getRunIdleTimeoutMs`（保留）。未验证 controls.cfg 缺失时 `getRunIdleTimeoutMs` 是否返回默认值还是“无超时”。

## Real-use impact

若缺省即无超时，挂起的 CLI 在会议中仍无限期存活（所有 CLI，非仅 Grok）。

## Fix

先补测试核实；若缺省等于不超时，改为使用默认 idle 预算。

## Acceptance criteria

- [ ] controls.cfg 缺失时，会议 run 有有限 idle 预算并在静默后结束。

## Required tests

- 会议 orchestrator 集成测试：无 controls.cfg + 静默的假 CLI → 在预算内结束；有配置时使用配置值。
