# Task 9ar — P09ar CRLF 被当作回车覆盖，Windows 输出变空行

**Status:** merged → [P09aq](P09aq-grok-unknown-model-terminal-message.md)
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（#52 Codex 定向 review，`7514c1e`，已接受）
**Found in:** #52 Codex scoped review，2026-10-20
**Blocked by:** None

## Codex finding (verbatim)

> **Preserve CRLF lines before applying carriage-return overwrites**
> 
> For ordinary Windows `\r\n` text, this clears the accumulated line on `\r` immediately before `\n` appends it, so `"first\r\nsecond\r\n"` becomes two blank lines. Grok tool results and final text both pass through this helper, causing normal Windows command output to disappear; treat CR followed by LF as a newline and reserve overwrite handling for standalone carriage returns.

**位置：** `src/agent/terminal-text.ts:40`

## Fix direction

`\r\n` 视为换行；仅独立 `\r` 做覆盖处理。

## Acceptance criteria

- [ ] `\r\n` 视为换行；仅独立 `\r` 做覆盖处理。

## Test requirement

- 回归测试：`"first\r\nsecond\r\n"` → 保留 first/second 两行；独立 `\r` 覆盖行为不变。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
