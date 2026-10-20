# Task 9ae — P09ae Profile 访问模式不映射到 grok argv（read-only 仍 --always-approve）

**Status:** todo · bug · P2
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（Grok Build 只读审计 G5，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

`mapGrokEffectiveAccess` 返回 `{}`，`buildGrokArgs` 固定加 `--always-approve`，从不读 `opts.sandbox/permissionMode`；grok 1.0.41 支持 `--permission-mode` 与 `--sandbox`。当前两个 grok profile 均为 `maxAccess=full`，但 read-only profile 会得到完全放行的 shell。

**位置：** `src/agent/grok/argv.ts:31-35`；`src/agent/grok/options.ts:30-32`；`src/agent/grok/metadata.ts:50-53`；`src/agent/grok/adapter.ts:67-98`

## Repro

对任意输入调用 `buildGrokArgs`：始终含 `--always-approve`，从无 `--permission-mode`/`--sandbox`。

## Acceptance criteria

- [ ] 每种 `EffectiveAccess` 映射到对应 grok flag；`read-only` 不传 `--always-approve`。
- [ ] `runtimeAccess()` 状态行与实际 argv 一致。

## Test requirement

- 对每种 `EffectiveAccess` 断言 `GrokAdapter.run` 捕获的 argv 含正确 `--permission-mode`/`--sandbox`，read-only 不含 `--always-approve`。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
