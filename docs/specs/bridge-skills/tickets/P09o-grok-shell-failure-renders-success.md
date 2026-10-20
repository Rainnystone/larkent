# Task 9o — P09o Grok shell 失败被渲染为成功（shell 判定漏了 `run_terminal_command`）

**Status:** done · fixed in #52 by 96cc1fd; live FX-o/FX-s PASS @b4cda3f（2026-10-20） · bug
**Delivers:** Grok Build 的 shell 调用退出码非 0 时，卡片显示失败状态，并保留命令与输出；退出码推断只作用于真正的 shell 工具。
**Found in:** 真实飞书测试 bridge，代码 head `b4d67c6`（#52）live 复验
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** Grok Build 执行一次 shell 调用（heredoc 方式的 bridge tool call，`&&` 后接对不存在路径的 `ls`）。原生事件：tool `run_terminal_command`，status `completed`，exit 2。
- **期望：** 卡片显示失败状态，命令与 `ls` 错误输出可见。
- **实际：** 卡片显示了命令和 `ls` 错误，但标记为成功。
- **未受影响：** 单独的 pipe / heredoc bridge 调用仍正确折叠；非 shell 的 `read_file` 文本中含 `exitCode` 时未被标为失败（弱证据：当前没有任何 Grok 工具被当作 shell）。
- **严重度：** P2（失败被显示为成功，误导用户）。

## Root cause

- `src/agent/shell-tool.ts` 共享 shell 判定只列了 `run_terminal_cmd`，没有 `run_terminal_command`，因此 `b4d67c6` 的退出码推断对 Grok 从不生效。

## What to build

- shell 判定加入 Grok 实际工具名 `run_terminal_command`；不扩大到非 shell 工具。
- 可选（同一修复内）：heredoc 命令渲染时每行后多出空行；Node 的 `NO_COLOR ignored due to FORCE_COLOR` stderr 警告泄漏到卡片。

## Acceptance criteria

- [ ] Grok shell exit≠0 → 失败状态，命令与输出可见。
- [ ] Grok shell exit 0 → 成功；单独的 bridge 调用仍折叠。
- [ ] 非 shell 工具文本含 `exitCode` 永不判为失败。
- [ ] 测试使用真实 Grok 工具名 `run_terminal_command`。
- [ ] 在 Bot Arena live 复验。
