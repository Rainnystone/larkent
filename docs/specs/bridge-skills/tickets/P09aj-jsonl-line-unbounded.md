# Task 9aj — P09aj 单行 JSONL 无大小上限地缓冲

**Status:** todo · bug · P3
**Owner:** local Grok Build
**Audit verdict:** PARTIAL（Grok Build 只读审计 G10，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Follow-up:** [P09bd](P09bd-jsonl-line-cap-bytes.md)（共享/非 Grok 代码影响评估，2026-10-20）
**Blocked by:** None

## Root cause

stdout 按 `\n` 切分，行缓冲无上限；大文件 `read_file`/shell 输出为单行 JSON，整行驻留内存后才截断到 1200 字。部分成立：实测最长行 2959 字节，未复现内存问题，属健壮性风险（共享 16GB 无 swap 机器上有现实意义）。

**位置：** `src/agent/runner/jsonl-cli-runner.ts:266-277`

## Repro

向 runner 写入单行超大 JSON（如 64 MiB）：内存线性增长，无上限。

## Acceptance criteria

- [ ] 单行超过上限（如 8 MiB）时截断该事件或以明确错误结束运行，不无限缓冲。

## Test requirement

- 向 runner 送超过上限的单行，断言运行失败/事件被截断而非整行缓冲。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
