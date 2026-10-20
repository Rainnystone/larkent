# Task 9ah — P09ah 会议运行无 idle watchdog，挂起的 grok 无限期存活

**Status:** todo · bug · P2
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（Grok Build 只读审计 G8，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

`GrokAdapter` 不向 `runJsonlCli` 传 `timeouts`；chat 与 automation 用 `createIdleWatchdog` 补偿，`runMeetingAgent` 没有。

**位置：** `src/meeting/orchestrator.ts:~344-398`；`src/agent/grok/adapter.ts:72-98`；`rg createIdleWatchdog src/meeting` 为空

## Repro

会议提问中让 adapter 的 stdout 永不关闭：运行不会结束，直到会议停止或进程退出。

## Acceptance criteria

- [ ] 会议运行在配置的 idle 预算后停止，并给出非空超时提示。

## Test requirement

- 会议运行 + stdout 永不关闭的 fake adapter：断言 idle 预算后停止并返回超时提示（fake timers）。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
