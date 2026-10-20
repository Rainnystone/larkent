# Task 09bd — P09bd JSONL 8MB 单行上限按字符索引比较字节数

**Status:** todo · bug · P3（#52，保留修复）
**Owner:** Codex
**Follow-up of:** [P09aj](P09aj-jsonl-line-unbounded.md)（修复提交 `abf36e5`）；与 [P09au](P09au-jsonl-line-bytes.md) 同一问题，本票将其纳入 #52
**Blocked by:** P09aq（同文件；待 P09aq 绿后一批交接）
**Evidence:** 代码阅读 `7514c1e` 对比 merge-base `953e7bd`；**未 live 验证**（box PATH 上无各 CLI）。

## Root cause

`jsonl-cli-runner` 8MB 单行上限（保留）中 `nl > maxLineBytes` 用字符索引比较字节数。

## Real-use impact

多字节（中文）输出时上限实际可达约 3 倍；对所有 CLI 生效。

## Fix

改为按 UTF-8 字节比较（如 `Buffer.byteLength` 或在 Buffer 层计数）。

## Acceptance criteria

- [ ] 上限按字节精确生效。

## Required tests

- 恰好低于 / 恰好超过上限；纯中文多字节行在字节越界时被截断/拒绝，字符数未越界不影响判断。
