# Task 9aq — P09aq stderr 为空串时 unknown-model 未用终态消息分类

**Status:** todo · bug · P2
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（#52 Codex 定向 review，`7514c1e`，已接受）
**Found in:** #52 Codex scoped review，2026-10-20
**Blocked by:** None

## Codex finding (verbatim)

> **Match unknown-model errors from the terminal event**
> 
> The observed unknown-model failure is emitted as a Grok JSONL `error` on stdout, but the outcome paths use `run.stderrSnapshot ?? event.message`; an empty stderr snapshot is `""`, not `undefined`, so the terminal message is never passed to this signature. The new rule therefore does not classify the real failure and users still receive the generic error instead of the model guidance; fall back on the terminal message when stderr is empty or match both sources.

**位置：** `src/agent/grok/stderr-signatures.ts:16`

## Fix direction

结果路径中 stderr 快照为空（`""`/仅空白）时回退到终态 error message（或两者都匹配），使 unknown-model 签名生效。

## Acceptance criteria

- [ ] 结果路径中 stderr 快照为空（`""`/仅空白）时回退到终态 error message（或两者都匹配），使 unknown-model 签名生效。

## Test requirement

- 回归测试：stderr 快照 `""` + 终态 error 为 unknown-model 文本 → 输出模型指引；stderr 非空时原逻辑不变。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
