# Task 9ap — P09ap 404 签名误匹配任意 `404 Not Found`

**Status:** deferred · bug · P3
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（#52 Codex 定向 review，`7514c1e`，已接受）
**Found in:** #52 Codex scoped review，2026-10-20
**Blocked by:** None
**Deferred reason:** 未观察到 Grok 产生非会话类 404。（2026-10-20 实测分诊，本轮不修）

## Codex finding (verbatim)

> **Limit the 404 signature to session restoration failures**
> 
> Any Grok stderr containing the generic text `404 Not Found` matches this alternation, even when the 404 came from an unrelated API or resource rather than session restoration. Such failures are then shown as “session does not exist” with instructions to start a new turn, obscuring the real problem; require the observed `session get failed: 404` context instead of matching every 404.

**位置：** `src/agent/grok/stderr-signatures.ts:22`

## Fix direction

只在出现 `session get failed: 404` 上下文时匹配“会话不存在”，去掉泛化的 `404 Not Found` 分支。

## Acceptance criteria

- [ ] 只在出现 `session get failed: 404` 上下文时匹配“会话不存在”，去掉泛化的 `404 Not Found` 分支。

## Test requirement

- 回归测试：`session get failed: 404` → 会话不存在提示；仅含无关 `404 Not Found` → 不匹配该签名。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
