# Task 9r — P09r 工具卡出现 ANSI 颜色转义码

**Status:** todo · bug · P3
**Delivers:** 工具卡输出不含 ANSI 转义序列，也不出现 Node 的 `NO_COLOR` 警告。
**Found in:** 真实飞书测试 bridge，代码 head `b4d67c6`（#52）全量回归
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** agent 在工具调用中运行 `node -e` 打印数值，结果显示在工具卡中。
- **期望：** 卡片显示纯文本输出。
- **实际：** 输出以 `\u001b[33m…\u001b[39m` 这类 ANSI 颜色码包裹；同时每次 tool client 调用的 stderr 都有 `NO_COLOR ... ignored due to FORCE_COLOR` 警告泄漏到卡片。
- **严重度：** P3（可在飞书触发；外观问题）。

## Root cause

- 子进程环境同时继承 `FORCE_COLOR` 与 `NO_COLOR`，Node 子进程按 `FORCE_COLOR` 输出颜色并打印警告。与 P09o 可选项中的 NO_COLOR/FORCE_COLOR 警告同源，合并在同一修复中处理。

## What to build

- 为工具子进程环境去掉 `FORCE_COLOR`（`src/agent/lark-channel-env.ts`），和 / 或在工具卡渲染时剥离 ANSI 序列。

## Acceptance criteria

- [ ] 工具卡不出现 ANSI 序列。
- [ ] 工具卡不出现 `NO_COLOR` 警告。
- [ ] 在飞书测试群 live 复验。
