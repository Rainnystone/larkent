# Task 9b — P09b 重连补发的人工消息被判为非人工，automation 全部不可用

**Status:** ready-for-agent · bug · P2
**Delivers:** 桥重连/重启后通过 backfill 补发的真人消息，与实时到达的同一消息一样按人工 IM run 处理，automation.* 可用。
**Found in:** [P09](P09-real-feishu-acceptance.md) 真实飞书 E2E，候选版本 `0b55865`（kimi、grok 两个 profile 均复现）
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** 群里真人 @bot 发“列出本群自动化”，此时桥离线（停止、切换或断线）；桥启动后 backfill 把该消息重新入队并处理。
- **期望：** 无论实时到达还是补发，都按人工 IM run 处理，`automation.list` 正常返回本群任务；create/replace/delete/pause/resume 同样可用。
- **实际：** 补发那一轮所有 automation.* 能力都是 `available:false, reason:automation-requires-human`，`automation.list` 返回 `{"category":"unavailable","code":"automation-requires-human"}`，模型如实回复“当前无法列出”。同一 profile 随后实时发送的同一句话正常。另一个 profile 的 backfill 批次中，连 `automation.create` 探测也返回 `automation-requires-human`。
- **影响：** 真实用户在任何重启或断线补发后都会遇到自动化请求被拒。回复诚实、无错误副作用、重发即可恢复，因此不是 P1。
- **严重度：** P2。

## Evidence

- P09 证据目录中的 bug-list B5 行、`read-kimi-1.json`、`read-kimi-3.json`（补发轮与实时轮的回复回读）。
- 受影响 profile 的 jsonl 日志：`backfill enqueued` 之后该轮的 agent stderr 中工具结果为 `automation-requires-human`。
- 测试截图（盒子本地证据目录）。

## Root cause（`0b55865`）

- `src/bot/backfill.ts:461` `normalizeHistoryItem` 调用 `normalize(raw, { botIdentity, stripBotMentions, fetchSubMessages })` 时没有传 `includeRaw: true`；`@larksuite/channel` 的 `normalize` 只有 `opts.includeRaw` 为真才保留 `msg.raw`。
- 因此补发消息的 `msg.raw` 为 `undefined`，`senderTypeFromRaw()` 返回 `undefined`，`src/bot/channel.ts:1839` 的 `!== 'user'` 判定为 `automation-requires-human`。
- 实时路径在 `src/bot/channel.ts:475` 设置了 `includeRawEvent: true`，所以不受影响。
- 同一缺失也影响 `src/bot/channel.ts:3598` 依赖 `msg.raw` 的 `senderType` 记录。

## What to build

- backfill 归一化保留与实时路径等价的原始事件（`includeRaw: true`），或以等价方式把 sender_type 带入补发消息；两条路径用同一个判定函数。
- 当原始字段确实缺失时（历史 API 不返回 sender_type 等），不得静默当作非人工：要么从历史条目的 `sender.sender_type` 取值，要么返回可区分的诊断（不是 `automation-requires-human`），并在日志中记录原因。
- bot 自己发出的消息、其他 app 消息在补发路径上仍判为非人工。

## Acceptance criteria

- [ ] 新增失败用例：构造一条 sender_type=user 的历史条目走 backfill 归一化，`senderTypeFromRaw` 结果为 `user`，该轮 automation 可用性为 available；修复前失败、修复后通过。
- [ ] 对照用例：sender_type=app（含本 bot）的历史条目补发后仍为 `automation-requires-human`。
- [ ] T1 业务链：停止桥 → 注入一条真人“列出本群自动化”历史消息 → 启动桥 → backfill 入队 → `automation.list` 返回 ok 类结果而非 unavailable。
- [ ] `pnpm ci:local` 通过。
- [ ] P09 重跑：停桥期间真人 @bot 发管理查询，启动后补发轮能正常列出任务。

## Non-goals

- 测试环境中多个 profile 共用一个 app 导致的跨 profile 重复处理（P09 记为 env，生产一 app 一 profile）。
