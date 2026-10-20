# Task 9u — P09u Grok shell 自带 FORCE_COLOR，与 bridge 的 NO_COLOR 冲突，Node 警告进入工具卡

**Status:** done · fixed in #52 by 77c62b3; live FX-u PASS @b4cda3f（2026-10-20） · bug · P2/P3
**Owner:** local Grok Build
**Delivers:** Grok 工具卡不再出现 `The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set` 警告。
**Found in:** 真实飞书测试 bridge，代码 head `6dd0e44`（#52），2026-10-20 live 回归
**Worker class:** judgment
**Blocked by:** None

## Bug

- **场景：** Grok 在 shell 中运行任何 `node`（包括 `node "$LARK_BRIDGE_TOOL_CLIENT" tool`）。
- **实际：** 每次输出前两行为 `(node:PID) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.` 与 `(Use \`node --trace-warnings ...\` to show where the warning was created)`。
- **严重度：** P2/P3（每张工具卡都有噪音；P09r 的 env 修复对 Grok 无效）。

## Root cause

- `src/agent/lark-channel-env.ts:15-16` 设置 `NO_COLOR=1` 并删除 `FORCE_COLOR`；但 Grok 1.0.41 的 shell 工具自身在子进程环境中重新设置 `FORCE_COLOR=1` / `CLICOLOR_FORCE=1`，bridge 无法控制。两者并存时 Node 打印警告。

## 决定的修复

- **在 Grok 适配器中不注入 `NO_COLOR`**（Grok 构建环境时覆盖 / 删除 `NO_COLOR`），从根源消除冲突；颜色由 P09t 的 ANSI 剥离处理。其他 CLI 适配器保持 `NO_COLOR`。
- 不采用“过滤警告行”：会误删用户程序自身相同文本的输出，且属于症状处理。

## Acceptance criteria

- [ ] Grok spawn 的环境不含 `NO_COLOR`（且仍不含 bridge 注入的 `FORCE_COLOR`）。
- [ ] Codex/Claude 等其他适配器环境仍含 `NO_COLOR=1`。
- [ ] live 复验 Grok 工具卡无 NO_COLOR 警告、无 ANSI。

## Test requirement

- Grok 适配器 env 构建测试：断言无 `NO_COLOR`；共享 `buildLarkChannelEnv` 现有测试保持通过。
