# 3: interruption notice 卡片

**Blocked by:** 4

**Status:** ready-for-agent

## Parent

[docs/specs/run-reliability.md](../../../docs/specs/run-reliability.md) — 5.7, D5–D13

## What to build

- 开关 `notice.enabled` per profile，默认关。
- 触发：outcome `interrupted`（排除 `user-stop` 与 session 切换）或 retriable 的 `failed`/`partial`。auth-required 走 D10：不给继续；chat 内告诉 initiator 一次 + 私聊 owner 一次，去重；不暂停新 run。
- 新消息 @ initiator，「继续 / 暂不」按钮，文案“或 @bot 继续”；话题群 `replyInThread`。
- 新签名 action：turnId + journal fingerprint + 一次性 nonce + TTL；session 切换或 fingerprint 变化后失效；点击者需通过该 chat 的 access（任何被允许的用户均可，不限 initiator）。
- 继续 = 同 resume handle + 一次性中断提示；无 handle 时重跑原批次。该 scope 下一条普通消息也带一次提示。
- 连续 3 次上限（per session/scope），普通用户消息重置；第 4 次纯文本。
- 通知作为 journal 待发项；重启后限流。

## Test plan

- 非 initiator 但被允许的用户点击 → 继续成功；不被允许的用户（含围栏外 owner）→ 拒绝。
- `/new` 或 `/cd` 之后点击 → 失效提示；nonce 重放 → 拒绝；TTL 过期 → 拒绝。
- 继续请求带 resumeHandle 与一次性提示，prompt 不含原始文本；无 handle → 重跑原批次。
- 连续第 4 次中断 → 纯文本无按钮；中间一条普通消息后计数重置。
- 话题群通知落在原话题；需 @ 群文案含 @bot。
- 发通知时飞书不可达 → 恢复后补发恰好一次；重启后多条待发按限流发送。
- auth-required → 无继续按钮；initiator 与 owner 各一次，重复失败不重复通知；新 run 照常。
- 开关关闭时行为与 ticket 4 后的 master 一致。
- `pnpm ci:local` 绿；test bridge：cursor-stall 场景 → 卡片 → 按钮继续 / “@bot 继续”各一次。

## Acceptance criteria

- [ ] 测试计划中的自动化测试先红后绿。
- [ ] 改变行为的部分有 profile 开关，关闭时与 master 一致。
- [ ] 无真实 app id / chat id / open id / secret 入库。
- [ ] `pnpm ci:local` 绿；delivery note 填写（含 test bridge 证据，脱敏）。

## Out of scope

- 自动续跑（禁止）；keepalive 杀 run；后台任务探测。
