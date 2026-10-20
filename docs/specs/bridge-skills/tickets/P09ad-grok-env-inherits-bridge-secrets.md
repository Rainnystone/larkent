# Task 9ad — P09ad Grok 及其 shell 继承 bridge 全部进程环境（含凭据类变量）

**Status:** todo · bug · P1
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（Grok Build 只读审计 G4，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

`mergeProcessEnv(process.env, …)` 原样复制 bridge 环境，无 allowlist/denylist；配合 `--always-approve`，任意 shell 命令可读取并通过工具卡（1200 字）回显。实测运行中的生产与测试 bridge 进程环境均含凭据类变量名：`WAKE_WEBHOOK_KEY`、`WAKE_WEBHOOK_URL`、`SAND_BOX_AUTH_ID`、`CLOUD_AGENT_INJECTED_SECRET_NAMES`（仅记录变量名）。样本 s2 证明父进程变量可在工具 `rawOutput` 中读到。

**位置：** `src/agent/grok/adapter.ts:82-88`；`src/platform/spawn.ts:90-104`；`src/card/tool-render.ts:8`

## Repro

在 `process.env` 设 `AUDIT_SENTINEL=present`，经 adapter env 合并 spawn grok，执行 `node -e 'console.log(Boolean(process.env.AUDIT_SENTINEL))'` → `true`。

## Acceptance criteria

- [ ] 传给 agent 子进程的 env 采用 allowlist（PATH/HOME/LANG/TERM、CLI 自身认证所需变量、`LARK_BRIDGE_TOOL_*` 等），或至少 denylist 名称匹配 `*KEY*|*TOKEN*|*SECRET*|*PASSWORD*|*AUTH*|*WEBHOOK*`。
- [ ] `toolEnv` 的 `LARK_BRIDGE_TOOL_*` 保留。
- [ ] 评估是否同样适用于其他 adapter（共享 helper）。
- [ ] 合并 #52 前修复。

## Test requirement

- 单测捕获传给 `spawnProcess` 的 env：断言 `AUDIT_SENTINEL`、`WAKE_WEBHOOK_KEY`、`SAND_BOX_AUTH_ID` 等不存在，`LARK_BRIDGE_TOOL_*` 与 `PATH`/`HOME` 存在。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
