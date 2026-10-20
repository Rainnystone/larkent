# Task 9as — P09as 凭据透传 allowlist 未按 adapter 区分

**Status:** wontfix · bug
**Wontfix reason:** 2026-10-20 用户确认不修。
**Owner:** Codex（CLI 无关，邮件交接）
**Audit verdict:** CONFIRMED（#52 Codex 定向 review，`7514c1e`，已接受）
**Found in:** #52 Codex scoped review，2026-10-20
**Blocked by:** None

## Codex finding (verbatim)

> **Scope credential passthrough to the selected CLI**
> 
> When the bridge process contains credentials for multiple providers, this shared allowlist passes all of them to every adapter: for example, a Grok or Cursor child receives both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Because agent commands can inspect their environment, selecting one CLI unnecessarily exposes every other provider credential; make credential allowlisting adapter-specific while continuing to exclude bridge secrets such as `APP_SECRET`.

**位置：** `src/platform/spawn.ts:163`

## Fix direction

按 adapter 定义凭据 allowlist，只透传所选 CLI 需要的 provider 凭据；继续排除 `APP_SECRET` 等 bridge 密钥。

## Acceptance criteria

- [ ] 按 adapter 定义凭据 allowlist，只透传所选 CLI 需要的 provider 凭据；继续排除 `APP_SECRET` 等 bridge 密钥。

## Test requirement

- 回归测试：Grok/Cursor 子进程环境不含 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` 等他家凭据；各 adapter 仍收到自身凭据；任何 adapter 都不含 `APP_SECRET`。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
