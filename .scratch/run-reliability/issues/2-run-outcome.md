# 2: RunOutcome 模型与 stop reason 枚举

**Blocked by:** 1

**Status:** ready-for-agent

## Parent

[docs/specs/run-reliability.md](../../../docs/specs/run-reliability.md) — 1, 5.4

## What to build

- `stopRequest` 枚举（见 spec 5.4），在每个调用点设置，先写者胜；替换 `RunHandle.interrupted` 布尔（可保留派生 getter 兼容）。
- `deriveRunOutcome(stopRequest, exit, signal, terminalEvent, stderrTail, signatures)` 纯函数；本 ticket 签名表为空（ticket 5 填）。
- 真实终态胜出：stop 请求与真实终态同时出现时不丢弃终态事件（`channel.ts:1762`）。
- 卡片终态（`run-state.ts`）区分 runner timeout 与 bridge idle watchdog；从 outcome 派生，switch 用 `never` 穷尽。
- 决定并记录子进程是否独立进程组（`src/platform/spawn.ts`）。
- `card.final`、`run.failed` 日志带 `stopReason`、`outcome`。

## Test plan

- 每个 stop 调用点一个 reason 测试：`/stop`、`/new`、`/cd`、`/ws use`、`/resume`、meeting interrupt、`/exit`、`/account`、`/reconnect`、keepalive restart、shutdown SIGTERM、idle watchdog、runner timeout、subscriber abandoned。
- 无 stop 请求 + 信号退出 → `interrupted(external-signal)`。
- 竞态：终态事件与 stop 同时 → 终态胜出。
- `deriveRunOutcome` 表驱动单测覆盖所有类别；类型层 `never` 检查。
- 卡片 golden（`tests/static`）：runner timeout 与 idle watchdog 不同文案；其余卡片不变（P1 parity 测试保持绿）。
- `pnpm ci:local` 绿。

## Acceptance criteria

- [ ] 测试计划中的自动化测试先红后绿。
- [ ] 改变行为的部分有 profile 开关，关闭时与 master 一致。
- [ ] 无真实 app id / chat id / open id / secret 入库。
- [ ] `pnpm ci:local` 绿；delivery note 填写（含 test bridge 证据，脱敏）。

## Out of scope

- 签名表内容；journal；通知。
