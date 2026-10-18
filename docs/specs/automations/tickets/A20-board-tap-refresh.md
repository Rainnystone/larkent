# A20 — 看板按钮点击后看板不变、无回复；card.update 失败被吞；一次性卡片点击后按钮仍可点

Status: ready-for-agent
Severity: **high**（A11 @ Bot Arena 2026-10-18 实测：点【暂停】/【删除】后任务确实变了，但看板不变、没人回复，成员以为失败又点一次）
Blocked by: A19（同样改 `src/automations/board.ts`）
Track: 推到现有 code 分支 `feat/automations-v2`（PR #49），**#49 合入前完成**，不开新 PR
Spec: [../../automations.md](../../automations.md) §7（点击后卡片原地更新；卡片无法更新时重发并置顶）、§3（确认卡）

## 现象（A11，2026-10-18）

群成员在置顶看板上点【暂停】或【删除】。任务确实暂停 / 删除了，但看板不变，也没有任何回复，按钮转圈后回弹。看板要等到下一次无关的刷新才变对。

**证据（脱敏）**
- 日志有 `auto.paused id=14`、`auto.deleted id=13`；store 已更新。
- 看板消息的 `update_time` 变了，内容却是旧的；本地 sequence 从 27 涨到 35，日志里没有任何失败。

## 根因（`91b9dec` 只读核对）

1. `src/automations/board.ts:181-184`（`patch`）调用 `channel.updateCardById` 后直接把 sequence +1 写回 store，不看响应。SDK 的 `updateCardFull`（`@larksuite/channel` dist `index.mjs` 约 4575-4587）丢弃了 `cardkit.v1.card.update` 的响应；飞书的业务错误码（HTTP 200、`code != 0`）不会抛异常。所以失败被当作成功，sequence 仍然 +1。
2. 看板刷新在同一张卡片的回调里同步 await：`src/card/dispatcher.ts:532/540` → scheduler（`src/automations/scheduler.ts:681-687`，`writeStatus → onChanged → board.refresh`）。回调最后什么都不返回，客户端只能转圈后回弹。

## 要做

**(a) 检查 card.update 的响应码**
- `code != 0` 视为失败：**不** bump sequence，记录 `code` 与 `msg`（不记卡片内容），并按 spec §7 恢复：卡片无法更新时重发并置顶、尝试取消旧卡置顶。
- 不改 `node_modules`。仓库已经用 pnpm `patchedDependencies` 给 `@larksuite/channel@0.7.1` 打补丁（`patches/@larksuite__channel@0.7.1.patch`）。二选一，写进 PR 说明：
  - 在现有补丁里让 `updateCardFull` 返回（或在非 0 时抛出）响应；或
  - 在 board 里用 channel 暴露的 client 直接调用 `cardkit.v1.card.update` 并检查 `code`，绕开 `updateCardById`。
- 优先第二种：不加深对 SDK 内部的补丁，升级 SDK 时不用重做。

**(b) 点击看板按钮必须看得到看板变化**
- 选择：**回调立即返回 toast，回调返回之后再异步刷新看板**（走 (a) 的检查过的 card.update）。不在回调响应里返回整张卡片。
- 理由：
  - 飞书要求卡片回调在 3 秒内响应；看板刷新要读 store、查 pins、可能重新置顶，放在回调里有超时风险，超时就是现在的转圈回弹。
  - 看板是 CardKit 卡片实体（`card_id` + sequence）。回调响应里的卡片走的是另一条更新通道，与 sequence 并行写，容易乱序；只保留 card.update 一条写路径，sequence 才一致。
  - 刷新失败时 (a) 的恢复逻辑照样生效；在回调里返回卡片则没有失败信号。
- dispatcher 的 `auto.pause` / `auto.resume` / `auto.delete` 分支不再 await `board.refresh`；scheduler 的 `onChanged` 改成回调返回后调度（例如 `queueMicrotask` / `setImmediate` 或去抖队列），并保留去抖。

**(c) 成功时给 toast**
- 暂停：「已暂停 #14」；恢复：「已恢复 #14」；删除：「已删除 #13」（编号为 `/auto` 短编号）。
- 失败（编号不存在、签名无效、过期）返回对应的 toast，不静默（与 A18 一致）。

**(d) 一次性卡片点击或过期后，按钮变为不可点（用户 E2E 发现，2026-10-18）**

> **已被 [A22](A22-oneshot-card-keep-body.md) 修订（用户决定 2026-10-18）**：结算后保留原卡片正文，只把按钮行换成结果行；不再把整张卡换成状态行。

现象：任何人在确认卡（`/auto` 草稿确认）或其它一次性动作卡（「一个月」/「结束」等提示卡）上点了「是」或「否」之后，按钮仍然可以点。第二次点击只回复「此确认已失效」。

要做：
- 第一次有效点击后，或卡片过期时，**原地更新原卡片**：按钮设为 `disabled: true`（灰掉，可配 `disabled_tips`），或把按钮行换成一行状态文字，例如「已确认 #N」/「已取消」/「已过期」。二选一，单测锁住。
- 状态行**不写点击者姓名**（spec 没有允许）。
- 写路径与 (a)、(b) 相同：回调先返回 toast，回调返回之后再更新卡片；更新检查响应码，失败记 `code` / `msg`，不 bump sequence。
- 过期：卡片到 TTL 时由 scheduler（或同一去抖队列）触发一次原地更新；进程停机期间过期的，在启动时补一次更新。
- 服务端的「已过期 / 已消费」检查（nonce、TTL）**保留**，作为并发点击与旧客户端的兜底；兜底命中时仍回复 toast「此确认已失效」。
- 依据：飞书卡片 JSON 2.0 按钮组件有 `disabled`（布尔，默认 `false`）与 `disabled_tips`（禁用时 PC 悬停提示）字段。来源：[飞书开放平台 · 卡片 JSON 2.0 · 按钮](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button)。

## 验收

- [ ] 先写失败测试：`card.update` 返回 `code != 0` 时 `patch` 报失败，store 里的 sequence 不变，日志有 `code` / `msg`，触发重发并置顶。
- [ ] `code == 0` 时 sequence +1 并写回。
- [ ] dispatcher：点暂停 / 恢复 / 删除，回调响应含对应 toast，且在看板刷新完成前就返回；之后看板刷新恰好发生一次，内容反映新状态。
- [ ] 确认卡点「是」、点「否」后，测试断言原卡片更新被调用（在回调返回之后），更新后的卡片按钮 `disabled: true` 或按钮行已换成状态行，且不含姓名；更新失败时 sequence 不变、有日志。
- [ ] 过期：推进 fake clock 到 TTL，原卡片更新被调用一次；过期后再点仍回复「此确认已失效」。
- [ ] 并发：两次几乎同时的点击只有一次生效，另一次得到「此确认已失效」。
- [ ] 不改 `node_modules`；如改补丁，补丁有对应单测。
- [ ] A11 实测：在看板上点【暂停】、【恢复】、【删除】，每次都立刻看到 toast，几秒内看板可见更新；不需要再点第二次。
- [ ] A11 实测：确认卡点「否」、另一张点「是」、再一张等到过期，三张卡的按钮都灰掉（或换成状态行）。

## 不做

- 不改按钮权限（A18）。
- 不改 status push（A19）。
- 不在回调响应里返回整张卡片。

## 共同验收

- [ ] 先写失败测试，再实现。
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。

## A11 需重跑的场景

看板上点【暂停】、【恢复】、【删除】各一次；确认卡点「否」、点「是」、等过期各一张，按钮都灰掉：toast 立即出现，看板几秒内更新；再人为让一次 card.update 失败（测试注入），看板被重发并重新置顶。
