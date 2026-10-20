# Task 9al — P09al ANSI 剥离漏掉 CR/BEL；答案文本与 stderr 片段未剥离

**Status:** done · fixed in #52 by 123fff1（2026-10-20） · bug · P3
**Owner:** local Grok Build
**Audit verdict:** PARTIAL（Grok Build 只读审计 G12，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

`stripVTControlCharacters` 保留 `\r` 与 BEL；`final_text` 与 `fail()` 附加的 stderr 片段不经剥离。部分成立：实测样本中答案文本未出现 ESC。

**位置：** `src/agent/grok/jsonl.ts:296-298`；`src/agent/runner/jsonl-cli-runner.ts`（stderr 片段）

## Repro

工具输出 `prog\rDONE\u0007` 经 `serializeToolOutput` 后 `\r` 与 BEL 仍在。

## Acceptance criteria

- [ ] 工具输出、`final_text`、stderr 片段都去掉 ANSI、BEL，并合理处理 `\r` 进度覆盖。

## Test requirement

- 含 `\r` 进度与 BEL 的工具输出、含 `\u001b[31m` 的 text 块：断言到达卡片/final_text 时为纯文本。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
