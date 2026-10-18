# A29 — status push 的 `updatedAt` 严格递增（pusher 持有并持久化）

Status: ready-for-agent
Severity: **medium**（不修则 monitor 会把部分推送当作过期丢弃，monitor 持有的列表落后于本地）
Blocked by: A19
Track: 推到现有 code 分支 `feat/automations-v2`（PR #49），**#49 合入前完成**，不开新 PR
Spec: [../../automations.md](../../automations.md) §7（status push：`updatedAt` 规则与响应码表）、ADR-015 / ADR-022

## 现象

A19 的 pusher 把本地 status 文件里的 `updatedAt` 原样放进 payload（`src/automations/status-pusher.ts` 的 `post()`：`updatedAt: snapshot?.updatedAt ?? this.now()`），而 `items` 取自 `store.list()` 并按**当前** `now` 算 `nextFires`。status 文件的 `updatedAt` 只在 `store.writeStatus()` 时递增（`src/automations/store.ts` 的 `statusSnapshot()`）。于是：

- 失败后重试、启动推送、link 恢复推送：status 文件没重写 → `updatedAt` 不变，但 `nextFires` 窗口随 `now` 前移 → body 变了、`updatedAt` 没变。
- `store.list()` 已变而 status 文件尚未重写时推送：同上。

monitor 按 spec §7 对「`updatedAt` 不大于已存值且 body 不同」返回 **409**，pusher 不重试 409。结果是这次推送被丢弃，monitor 持有的列表比本地旧（仍按旧窗口判 miss）。这也违反 A19 的验收「同一状态连续推两次……`updatedAt` 严格递增，重启后也不回退」。

## 要做

- pusher 自己持有一个单调的 `updatedAt`（例如 `lastSentUpdatedAt` 与上一次已发送 body 的哈希），持久化在 profile 数据目录（原子写，与 status 文件同目录；文件内容只有数字和哈希，不含任何 ID、名称或 secret）。启动时读回；读不到时从 `max(now, status 文件 updatedAt)` 起步。
- 每次构造 payload：先用一个固定的 `updatedAt` 占位生成 body 并与上一次已发送的 body 比较（比较时忽略 `updatedAt`）：
  - **不同** → `updatedAt = max(now, lastSentUpdatedAt + 1)`，发送成功或失败前都先持久化，保证跨重启不回退；
  - **完全相同**（例如同一 body 的重试）→ 可以沿用 `lastSentUpdatedAt`（monitor 视为重复，返回 204）。
- 状态文件的 `updatedAt` 语义不变（看板仍用它）；payload 不再直接读它。
- 409 / 400 / 401 / 413 仍只记日志、不重试（与 spec §7 表一致）；429 与 5xx 仍按 `Retry-After` 与退避重试。
- 不改 payload 字段、签名、请求头或 debounce。

## 验收

- [ ] 先写失败测试：status 文件不变、fake clock 前进使 `nextFires` 变化后再推一次 → 第二次 payload 的 `updatedAt` 严格大于第一次（当前代码下这条测试失败）。
- [ ] 5xx 后的重试：body 不变时 `updatedAt` 与首发相同；body 已变（时钟前进越过一个计划时刻）时严格更大。
- [ ] 重启：用同一 profile 目录新建 pusher，第一次推送的 `updatedAt` 严格大于重启前最后一次已发送值，哪怕 fake clock 回拨。
- [ ] 启动推送与 link 恢复推送：body 与上次已发送不同则 `updatedAt` 严格更大。
- [ ] 同一毫秒内两次 body 不同的推送：第二次 `updatedAt` = 第一次 + 1。
- [ ] 持久化文件只含数字与哈希；不含 `oc_` / `ou_` / `om_` / `cli_` 形态的字符串、bot 名或 secret；secret 不出现在日志。
- [ ] A19 原有 status-push / status-pusher 测试全部仍然通过；未配置 endpoint 或 secret 时不读写该文件、不发请求。

## 不做

- 不实现 monitor 一侧（larkent-monitor 仓库的独立轨道，docs PR `docs/missed-fire`）。
- 不改唤醒入口：monitor 的 wake 不带 key（spec §7），被唤醒的 box 靠 Larkent 自身的启动补跑 / 墙钟重算。

## 共同验收

- [ ] 先写失败测试，再实现。
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。

## A11 需重跑的场景

配好 endpoint 后：让 monitor 暂时返回 5xx 再恢复，确认恢复后的推送被 monitor 接受（204，不是 409）；重启 bridge 后的启动推送被接受。
