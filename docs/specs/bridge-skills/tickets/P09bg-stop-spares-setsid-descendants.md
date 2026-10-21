# Task 09bg — P09bg /stop 后 CLI 以 setsid 新建会话的工具 shell 存活

**Status:** ready-for-agent（2026-10-21） · bug
**Owner:** local Grok Build（#52，`feat/bridge-skills`）
**Follow-up of:** [P09bc](P09bc-process-tree-sigkill-spared.md)；关联 [P09ai](P09ai-stop-leaves-grandchildren.md)、[P09at](P09at-process-tree-terminate-spared.md)
**Evidence:** 夜间 live FX-bc / FX-at / FX-ai 复测，Grok @`0aea2d7` 与 @`2610aa8` 均 **FAIL**；Kimi PASS；Antigravity 未测。

## Problem

`/stop` 后 grok 进程（自身 pgid/sid）退出，但其 shell 工具进程链 `bash -O extglob -c …` → `sh -c 'sleep 631 & sleep 632'` → `sleep 631/632` 仍存活，60s 后依旧在（父进程已被 init/子收割者接管）。

## Root cause

Grok CLI 对每个工具 shell 调用 `setsid`，工具进程处于**新的会话/进程组**（pgid=sid=工具 bash）。P09bc 只向 bridge 自己 spawn 的进程组发送 SIGTERM/SIGKILL，不覆盖 CLI 新建的会话；CLI 退出后这些进程被 reparent，按进程组已无法找到。

## Real-use impact

用户停止后，长命令（构建、服务、`sleep`）继续占用 CPU/内存/端口并可能继续写文件；多次 /stop 累积孤儿进程。

## Fix

在给 CLI 发信号**之前**，以被 spawn 的 CLI pid 为根遍历 `/proc/<pid>/stat` 的 ppid 树（或 cgroup/会话感知方式），快照全部后代 pid（含已 setsid 的），连同原进程组一并 SIGTERM，grace 后对仍存活者 SIGKILL。实现须与 CLI 无关（不针对 Grok 写特例），不得读取或输出 APP_SECRET 等凭据，非 Linux 回落到现有行为。

## Acceptance criteria

- [ ] /stop 后，被 spawn 的 CLI 的完整后代树（含调用了 setsid 的进程）在 kill grace 内全部终止。
- [ ] CLI 无关：Grok / Kimi / Codex / Antigravity 走同一路径，无 CLI 名分支。
- [ ] 不暴露 APP_SECRET 或其他凭据（日志、错误、测试输出中均无）。
- [ ] 不误杀 bridge 自身或无关进程（只处理快照到的后代 pid）。
- [ ] live FX-bc / FX-at / FX-ai 在 Grok 上 PASS。

## Required tests

- 回归单测（Linux）：fixture 子进程派生一个 `setsid` 的孙进程（独立 pgid/sid，忽略 SIGTERM 亦可），停止后断言 kill grace 内孙进程不再存活、run 结束。
- 定向运行，`--maxWorkers=2`；typecheck 通过。
