# 4: turn journal（未送达重发、孤儿检测、session 切换作废）

**Blocked by:** 2, 5

**Status:** delivered (`13ad3dd`)

## Parent

[docs/specs/run-reliability.md](../../../docs/specs/run-reliability.md) — 5.6, D2, D13

## What to build

- 每 profile 独立文件（如 `turn-journal.json`，`schemaVersion: 1`，原子写，有界保留），由 supervisor 持有并注入，像 ledger 一样跨 `controls.restart()`。
- 字段与状态见 spec 5.6。
- `completed-undelivered`：最终回复因 sdk 错误未送达 → 下一恢复信号重发（遵守 bridge-owned final reply / `outbound.skip-cli-already-sent`）。
- 启动孤儿检测：pid + 启动时间匹配仍存活 → kill（或等待上限）后再定 outcome；不得与孤儿自身回复重复。
- `supersedeSession` 全部调用点与 `/new` 把旧 session 未完成记录置 `voided`。
- 开关：写入默认开；恢复动作（重发、孤儿处理）可按 profile 关闭。

## Test plan

- kill -9 bridge（process 测试）后重启：记录被标为 interrupted，孤儿被处理，日志恰好一次 `journal.recovered`。
- 回复发送失败（recording channel 注入错误）→ `completed-undelivered` → 恢复信号后恰好重发一次。
- `/new`、`/cd`、`/ws use`、`/resume` 后旧记录 `voided`。
- 损坏/未来版本 journal 文件被拒且不覆盖原文件（与现有 loader 规则一致）。
- master 版代码忽略 journal 文件（回滚兼容说明 + 测试数据目录检查）。
- `pnpm ci:local` 绿；test bridge：kill 进程组 + 重启场景一次。

## Acceptance criteria

- [x] 测试计划中的自动化测试先红后绿。
- [x] 改变行为的部分有 profile 开关，关闭时与 master 一致。
- [x] 无真实 app id / chat id / open id / secret 入库。
- [x] `pnpm ci:local` 绿；delivery note 填写（含 test bridge 证据，脱敏）。

## Out of scope

- 通知卡本身（ticket 3）。
