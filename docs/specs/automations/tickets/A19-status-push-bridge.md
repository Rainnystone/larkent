# A19 — 看板去掉机读块；bridge 推送状态到 larkent-monitor

Status: ready-for-agent
Severity: **medium**（用户决定 2026-10-18：看板里的大块 JSON 影响阅读；status push 取代 status block）
Blocked by: —（只依赖 spec §7 的端点契约，不依赖 monitor 部署）
Track: 推到现有 code 分支 `feat/automations-v2`（PR #49），**#49 合入前完成**，不开新 PR
Spec: [../../automations.md](../../automations.md) §7（status push）、ADR-008 / ADR-014 / ADR-015

## 现象

看板卡里有一块可见的一行 JSON（status block，note 元素），给 larkent-monitor 读。用户不想在群里看到它。

## 要做

**(a) 看板只给人看**
- 从看板卡渲染里删掉 status block（note 元素和它的 JSON）。其它行、按钮、已错过 / 已跳过行不变。
- 本地 status 文件仍是事实源，格式不必改；看板与推送都由它派生。

**(b) status pusher**
- `POST <endpoint>/v1/status`，body 为 spec §7 的 payload v2：`v`、`botKey`、`updatedAt`、`items[{id, nextFires[], lastFireAt, paused, endAt}]`。
- `botKey`、`id` 以共享 secret 为 key 做 HMAC 派生后截断（例如 `HMAC(secret, profile)`、`HMAC(secret, profile + 编号)`），monitor 无法反推；不是飞书 ID，也不是 `/auto` 编号原文。轮换 secret 会改变全部 `botKey` / `id`（monitor 把未知 `botKey` 当新 bot）。
- `nextFires`：未来 24 小时内、最多 N 个计划时刻（N 写成常量，单测锁住），**只要存在下一次触发就至少 1 个**，哪怕在 24 小时以后。paused 或无后续触发时为空。
- 头部带 timestamp 与 `HMAC-SHA256(secret, timestamp + "." + body)`。防回放靠 monitor 侧的 ±5 分钟 timestamp **加上**每个 `botKey` 严格递增的 `updatedAt`；bridge 保证 `updatedAt` 严格递增（同毫秒冲突时 +1，跨重启也不回退）。`updatedAt` 不参与 miss 判定（spec ADR-022）。
- 整份覆盖：每次推送是该 bot 的完整列表。
- 触发：任何时间表变化（创建、确认、暂停 / 恢复、删除、到期）；**每次 fire 开始**（新 `lastFireAt = t`；含推进状态的已跳过 / 已错过结果）；启动；link 恢复。去抖合并最多几秒。**没有**「窗口过半」触发。
- 失败按指数退避重试（有上限）；下一次触发做一次全量同步。推送失败只写本地日志，不发群消息，不影响 fire。
- 配置：endpoint 与 secret 都可选，secret 不写日志。任一缺失 → 不推送，自动化照常在本地运行。

## 验收

- [ ] 看板快照：不含 note 机读块，不含 JSON 文本。
- [ ] payload 单测：不含飞书 ID 形态的字符串（`oc_` / `ou_` / `om_` / `cli_` 等）、群名、bot 名、任务内容、时间表规则、创建者；只含规定字段。
- [ ] 签名单测：给定 secret、timestamp、body，签名与参考值一致；body 变一个字节签名就变。
- [ ] 幂等：同一状态连续推两次，body 除 `updatedAt` 外相同；`updatedAt` 严格递增，重启后也不回退。
- [ ] 每次 fire 开始都触发一次推送，body 里该 item 的 `lastFireAt` 等于这次计划时刻；已跳过 / 已错过推进状态时同样推送。正常 fire 之后，按 spec ADR-022 的 monitor 规则对该 payload 求值不判 miss。
- [ ] `nextFires`：都在 `now` 之后；24 小时内最多 N 个；下一次触发在 24 小时以后（如每周任务）时仍恰好含这 1 个；paused 时为空。
- [ ] 没有「窗口过半」触发：两次 fire 之间不因窗口消耗而额外推送。
- [ ] 去抖：短时间内多次变化合并为一次推送，延迟不超过几秒。
- [ ] 重试：端点返回 5xx / 网络错误时按退避重试；恢复后下一次推送是全量。
- [ ] 未配置：没有 endpoint 或 secret 时不发起任何请求，fire / 看板行为不变。

## 不做

- 不实现 monitor 一侧（larkent-monitor 仓库的独立轨道）。
- 不改补跑规则与唤醒入口（A0c、A5）。
- 不把 secret 写进仓库或日志。

## 共同验收

- [ ] 先写失败测试，再实现。
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。

## A11 需重跑的场景

看板不再显示 JSON；配好 endpoint 后创建 / 暂停 / 删除各触发一次推送，monitor 侧收到对应推送（需要 monitor 接收端已部署）；正常 fire 后 monitor 不唤醒；停掉 bridge 跨过下一次触发（含一个每周任务），monitor 在 `scanSlack` 后唤醒一次 box。
