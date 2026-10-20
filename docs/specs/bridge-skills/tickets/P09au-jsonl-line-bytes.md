# Task 9au — P09au 完整 JSONL 行按 UTF-16 长度而非字节数检查

**Status:** deferred · bug · P3
**Owner:** Codex（CLI 无关，邮件交接）
**Audit verdict:** CONFIRMED（#52 Codex 定向 review，`7514c1e`，已接受）
**Found in:** #52 Codex scoped review，2026-10-20
**Blocked by:** None
**Deferred reason:** 需要 8–32 MB 的单行 JSONL 才能触发。（2026-10-20 实测分诊，本轮不修）

## Codex finding (verbatim)

> **Count complete JSONL lines by bytes**
> 
> When a complete non-ASCII line arrives with its newline, `nl` is a UTF-16 code-unit count rather than a byte count, and the buffer is sliced before the later `Buffer.byteLength` check. Consequently an 8–32 MB UTF-8 line can bypass an 8 MB `maxLineBytes` limit, undermining the new memory bound; measure the completed slice with `Buffer.byteLength` before accepting it.

**位置：** `src/agent/runner/jsonl-cli-runner.ts:289`

## Fix direction

接受完整行之前用 `Buffer.byteLength` 计量切片，超过 `maxLineBytes` 即按超限处理。

## Acceptance criteria

- [ ] 接受完整行之前用 `Buffer.byteLength` 计量切片，超过 `maxLineBytes` 即按超限处理。

## Test requirement

- 回归测试：带换行的多字节 UTF-8 行字节数超过 `maxLineBytes`（字符数未超）→ 被拒/按超限处理。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
