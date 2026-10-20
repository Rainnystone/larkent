# Task 9ak — P09ak `read_file` 工具卡显示 JSON 原文；usage 事件发三次

**Status:** done · fixed in #52 by c4443bc（2026-10-20） · bug · P3
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（Grok Build 只读审计 G11，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

`read_file` 的 `rawOutput` 为 `{type:"ReadFile",FileContent:{content,...}}`，非字节数组，卡片得到整个对象的 `JSON.stringify`。`end.usage` 只在完全相同时去重，仅多了 cost 也会第三次发出。

**位置：** `src/agent/grok/jsonl.ts:164-205`、`:278-294`

## Repro

样本 `s1-bridge-env.jsonl`：read_file 结果为 235 字符 JSON；2 个 `usage` + `end.usage` → 3 个 usage 事件。

## Acceptance criteria

- [ ] ReadFile 输出显示 `FileContent.content`。
- [ ] cost 只展示一次，不重复 usage 事件。

## Test requirement

- ReadFile fixture 断言输出为文件内容；s1 fixture 断言 usage 事件去重。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
