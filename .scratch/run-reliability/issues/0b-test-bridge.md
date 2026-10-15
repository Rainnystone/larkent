# 0b: repo 内隔离 test bridge 与确定性 vitest 层

**Blocked by:** 0a

**Status:** ready-for-agent

## Parent

[docs/specs/run-reliability.md](../../../docs/specs/run-reliability.md) — 5.2, D3, D4

## What to build

- `e2e/test-bridge/`（Node/TS，只支持 POSIX）：driver、shim、故障代理、场景、README。`package.json` 增加 `e2e:up|down|fault|send|read|scenario`；`files` 不变（不进 npm 包）；不放 `scripts/`。
- `e2e/test-bridge.example.json` 只有占位符（`<APP_ID>`、`<CHAT_ID>` 等）；真实值放 `e2e/.local/`，加进 `.gitignore`。
- 数据根默认 `~/.lark-channel-e2e/<instance>`，以 test 实例身份启动（触发 0a 的 live 根防护），开启 0a 围栏。
- tester 用户 token 在独立配置目录（`e2e/.local` 指向，位于 test 数据根之外），只用于向测试群发/读。
- shim：透传 `exec`；故障模式 `trap` 转发 TERM/INT/HUP；`--version`/`--help` 透传；故障 per-run 一次性，带 runId 过滤，`:sticky` 可选。模式至少：`cursor-stall`、`cursor-auth`（只模拟）、`agy-print-timeout`、`agy-interrupted`、`hang`、`delay:<s>`。
- 默认 fake CLI（脚本化 JSONL）；`--real-cli` 显式 flag 才透传真实 CLI。
- 故障代理（`HTTPS_PROXY` 只设给 test bridge）：disconnect、blackhole、EPROTO、EAI_AGAIN、slow，按 host 选择。
- 信号：`fault kill-cli --child-only` 与 `--process-group`；`ws-freeze` 仅作为 wake-up 场景。
- `down` 只按 pid 文件停，并核对 cmdline 属于 test 实例。
- 首个实验场景 `redelivery-short-gap`：代理断开 20–30s 期间 tester 发 @ 消息，恢复后看飞书是否 WS 重投、backfill 是否补到。结论写进 delivery note。

## Test plan

- vitest（`tests/integration/e2e-harness/*` 或同等位置）：shim 透传时 SIGTERM 到达真实子进程（用 `fake-executable.ts`），不出现 `stdout did not quiesce`；故障一次性生效且只命中匹配 runId；`--version` 透传。
- vitest：代理各模式对一个本地 HTTPS 目标产生预期错误码（ECONNRESET / 超时 / EPROTO / EAI_AGAIN 模拟）。
- vitest：配置加载拒绝 example 占位符、拒绝 live 根；`e2e/.local` 在 `.gitignore`（`git check-ignore` 断言）。
- 静态检查：仓库内 `e2e/` 不含 `cli_`、`oc_`、`ou_` 形态的真实 ID（加一个 grep 测试）。
- 手动（test bridge）：`e2e:up` → `e2e:send` → `e2e:read` 往返；每种故障一次；首个重投实验结果。
- `pnpm ci:local` 绿。

## Acceptance criteria

- [ ] 测试计划中的自动化测试先红后绿。
- [ ] 改变行为的部分有 profile 开关，关闭时与 master 一致。
- [ ] 无真实 app id / chat id / open id / secret 入库。
- [ ] `pnpm ci:local` 绿；delivery note 填写（含 test bridge 证据，脱敏）。

## Out of scope

- 修 ticket 1 的任何 bug；CLI 子命令；Windows 支持。
