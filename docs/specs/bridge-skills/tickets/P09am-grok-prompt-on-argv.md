# Task 9am — P09am 完整 prompt 与 rules 位于 argv（ps 可见）

**Status:** todo · bug · P3
**Owner:** local Grok Build
**Audit verdict:** PARTIAL（Grok Build 只读审计 G13，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

`-p <prompt>` 与 `--rules <rules>` 是完整 argv 元素，含 bridge_context，主机上 `ps` 全程可见。部分成立：grok 1.0.41 提供 `--prompt-file`，可规避 prompt 暴露；rules 仍需评估。

**位置：** `src/agent/grok/argv.ts:23-35`

## Repro

运行中 `ps -o args -p <grok pid>` 可见完整 prompt。

## Acceptance criteria

- [ ] 若 `--prompt-file` 在 headless `-p` 模式下行为等价，改用 0600 临时文件并在运行结束删除；否则记录为 won't-fix。

## Test requirement

- argv 单测：断言 argv 不含 prompt 原文，含 `--prompt-file` 路径，且运行结束后文件被删除。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
