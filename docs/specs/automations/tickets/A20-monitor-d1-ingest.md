# A20 — larkent-monitor：D1 接收 status push，miss 判定改读 D1（跨仓库）

Status: ready-for-agent
Severity: **medium**（用户决定 2026-10-18；配合 A19）
Blocked by: —（可独立部署；A19 只依赖本票的端点契约）
Track: **跨仓库**。代码在私有仓库 `Rainnystone/larkent-monitor`，按该仓库惯例双轨：先开 docs PR（spec + ticket，do not merge），再开 code PR。本票是契约与验收的来源；在 monitor 仓库的 docs PR 里镜像为下一个编号的 ticket，并链接回本票。
Spec: [../../automations.md](../../automations.md) §7（status push、larkent-monitor 契约）、ADR-008 / ADR-014 / ADR-015

## 要做

**(a) D1**
- 新增 D1 binding 与 migration：一张表，每个 `botKey` 一行（`botKey` 主键、`updatedAt`、`payload`），**不建额外索引**（每个索引会让每次写多算一行）。
- 写入用 upsert，只在新 `updatedAt` 大于已存值时覆盖。

**(b) `POST /v1/status`**
- 只接受 POST，其它方法 405；响应体为空。
- 校验 timestamp 在 ±5 分钟内、`HMAC-SHA256(secret, timestamp + "." + body)` 一致（常量时间比较）；失败 401，不回显原因细节。
- 校验 payload v2 结构；拒绝多余字段。secret 存 Worker secret，不进 `wrangler.toml`。

**(c) miss 判定改读 D1**
- cron 扫描从「读置顶卡片」改为「读 D1」。
- miss：未暂停，`now >` 最早的未覆盖 `nextFires` 时刻，且之后没有更新的推送或 `lastFireAt` 覆盖它。
- 过期：`nextFires` 全部已过而没有新推送，视为 miss。
- 每个 fire key（`id` + 计划时刻）至多唤醒一次；去重沿用 `MONITOR_KV`（或 D1 一张表，二选一写进 monitor spec）。

**(d) 退役飞书读取路径**
- 删掉读 pins / 消息的代码和对应测试。
- 文档（README、`docs/runbook.md`）去掉飞书读消息权限要求和相关凭据配置。

## 验收

- [ ] migration 只建一张表、无额外索引。
- [ ] 签名错误、timestamp 超出 ±5 分钟、非 POST、结构不符 → 拒绝且不写 D1。
- [ ] `updatedAt` 不大于已存值的推送不覆盖（回放 / 乱序）。
- [ ] miss 表驱动：`now == nextFire` 不算；paused 不算；`lastFireAt` 已覆盖不算；窗口耗尽算 miss。
- [ ] 同一 fire key 重复扫描只唤醒一次。
- [ ] 代码里没有飞书 OpenAPI 调用；文档不再要求飞书读权限。
- [ ] 部署后在免费计划额度内（D1 行写 / 天、Worker 请求 / 天），runbook 记下估算。

## 不做

- 不改 Larkent（见 A19）。
- 不做预唤醒（ADR-014）。

## E2E

需要 A19 与本票都就位：A11 里配好 endpoint，验证推送落 D1、窗口过期后唤醒一次、box 侧已执行时静默。
