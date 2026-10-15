# 1: 丢消息修复（全部路径）

**Blocked by:** 0b（实验结论）

**Status:** ready-for-agent

## Parent

[docs/specs/run-reliability.md](../../../docs/specs/run-reliability.md) — 1, 5.3, D2

## What to build

- `BackfillLedger.unrecord(messageId)`；ledger 仍 `schemaVersion: 1`，只追加字段。
- `disconnect()`/`pending.cancelAll()`：对未开始的 pending 调 `unrecord`，并 `markScanIncomplete(最早 createTime)`。
- short-gap：有被丢弃 pending 时由 `incompleteFrom` 强制补扫；其余按 0b 实验结论（若飞书不重投，提供开关让短 gap 也补扫）。
- 命令：只有语义上取消的命令（`/stop`、`/new`、`/cd`、`/ws use`、`/resume`、`/exit` 等）清空 pending，且对被清空项给出确认或撤销记录；只读命令不清空。
- `reconnect-in-progress`：不记 ledger（或撤销）并重新入队/`markScanIncomplete`；文案改为兑现得了的说法。
- restart 重叠窗口（`supervisor.ts:289-300`）：旧 bridge 断开后把 pending 交给新 bridge，或交接完成后再触发一次 backfill；`closing` 期间到达的事件进入移交或标记 incomplete。
- 截断（`backfill.ts:331-335`）：被截断的消息不记成已处理；免 @ 群：backfill 过滤与 live 规则一致。
- 更新 CONTEXT.md 中 **claim**、**processed ledger** 的定义。

## Test plan

vitest（红→绿），每条消息恰好回复一次、带 lateness hint、无重复：
- run 中连发两条 → `/reconnect`。
- run 中连发两条 → keepalive 触发的 `controls.restart()`（含重叠窗口：事件投给旧 socket）。
- SIGTERM 后重启（ledger 持久化后重载）。
- 代理断开 25s（short-gap 路径，`incompleteFrom` 绕过跳过）。
- pending 期间发 `/status` → pending 保留；发 `/stop` → 被清空项有确认且 ledger 已撤销。
- `reconnect-in-progress` 拒绝 → 下一次恢复信号补处理。
- `maxMentionsPerChat` 截断 → 被截断项下次可补；免 @ 群未 @ 消息可补。
- ledger 文件写出后仍被 master 版 loader 接受（v1 兼容测试）。
- 日志可见 `pending.handoff` / `backfill.forced` 一类事件。
test bridge：上述前 5 个场景各复现一次。`pnpm ci:local` 绿。

## Acceptance criteria

- [ ] 测试计划中的自动化测试先红后绿。
- [ ] 改变行为的部分有 profile 开关，关闭时与 master 一致。
- [ ] 无真实 app id / chat id / open id / secret 入库。
- [ ] `pnpm ci:local` 绿；delivery note 填写（含 test bridge 证据，脱敏）。

## Out of scope

- RunOutcome、journal、通知；keepalive 杀 run。
