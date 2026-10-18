# A25 — 看板遇 300317 原地重试（单调 sequence），只在卡片丢失/过期时重发；记录 patch 成功日志

Status: ready-for-agent
Severity: **high**（A11 r5 2026-10-18 实测：box 每次睡眠唤醒后都可能 300317 → 重发，当天 13:05–14:30 连续四次重发，群里留下多张旧看板）
Blocked by: A22（同样改看板 / 卡片更新路径；代码基准 `5552726` + A22）
Track: 推到现有 code 分支 `feat/automations-v2`（PR #49），**#49 合入前完成**，不开新 PR
Spec: [../../automations.md](../../automations.md) §7（卡片无法更新**（丢失/过期）**时才重发；300317 原地重试）、§10（`auto.board.patch` / `auto.board.resend`）

## 场景（A11 r5，真实触发，bridge 日志 2026-10-18，UTC+8）

box 睡眠后唤醒，`link.recovered` 触发 `board.refresh()`（`channel.ts:940-955`，Spec §7「link 恢复后刷新看板」），约 2 秒后 card.update 返回 300317（msg `sequence number compare failed`），bridge 立刻发新看板：

| 唤醒（tick-gap） | 300317 + `board.resend` | 新看板 | 失败的旧看板 |
|---|---|---|---|
| 13:04:56（160 s） | 13:05:00 | om_…7617 | om_…0697 |
| 14:03:33（1216 s） | 14:03:35 | om_…c357 | om_…7617 |
| 14:20:41（354 s） | 14:20:43 | om_…8776 | om_…c357（飞书 update_time 14:15:26，在睡眠窗内） |
| 14:30:10（269 s） | 14:30:13 | om_…d4fb | om_…8776（飞书 update_time 14:26:17，在睡眠窗内） |
| 14:57:37（1048 s） | 无，14:58:39 原地更新成功 | — | — |

每次重发都在群里留下一张还带按钮的旧看板（旧卡问题见 [A26](A26-board-settle-old-and-pending-list.md)）。

## 300317 的含义

飞书 CardKit 错误码表：`300317` = 对同一卡片实体的操作 sequence 没有严格递增。它**不表示**卡片丢失或过期（那是 200740 / 200750）；卡片实体仍然可以更新，只是本地 sequence 落后于服务端。注：[A21](A21-board-rebind-after-pin.md) 写的「13:05 置顶失败 300317」按 r5 日志实为 card.update（patch）失败，不是 pin。`300311` = 卡片属于其它应用（非本应用卡片），同样不是丢失/过期，不重发。2026-10-18 核实：300311=非本应用卡片（A25 实现侧 + 官方文档）。

## 触发

本地记录的 sequence 落后于服务端：服务端处理过一次本地没记下的操作（例如睡眠中的请求响应丢失）。从现有日志无法确定那次操作的发起方（成功的 patch 不写日志）。工程上的关键是：**不管漂移从哪来，当前实现都没有自愈路径**，下一次 refresh 一定是 300317，然后重发。14:58 d4fb 原地成功，说明不是每次唤醒都必然发生。

## 根因（`5552726`）

- `src/automations/board.ts:150-166` `patchOrResend`：除 not-in-chat 和 link 类以外，**任何** patch 失败（含 300317）都直接 `sendManagedCard` 发新卡，没有「换更大的 sequence 重试」。
- `board.ts:179-184` `patch`：`sequence = stored + 1`，只有 `code == 0` 才持久化（A20 有意设计，`board-update.test.ts:23` 锁定）。一旦漏记一次成功，本地永远落后。
- 重发条件比 Spec 宽：Spec §7 只要求「卡片无法更新（丢失/过期）时重发」。

## 要做

- **单调 sequence**：每次 card.update 用 `seq = max(stored + 1, floor((now − 2026-01-01T00:00:00Z) / 1000))`（秒级，int32 内）。只有 `code == 0` 才持久化（保留 A20 的语义）；即使漏记过一次成功响应，下一次也会超过服务端值。
- **300317 原地重试**：patch 返回 300317 时，用 `seq' = max(seq + 1, 时间派生值)` 立即重试**一次**；成功则持久化 `seq'`，不发新卡，pins 不变。重试仍失败：记 `code` / `msg`，**不重发**，保留绑定，下一次 refresh 再用更大的 sequence 尝试。
- **只在丢失/过期时重发**：200740、200750 以及「消息已删除 / 不存在」才走重发路径（A21 的先置顶后换绑定流程不变）。`300311`（非本应用卡片）记日志、不重发，保留绑定。其它 `code != 0`：记日志，不重发，保留绑定。not-in-chat、link 类保持现状。
- **日志**（Spec §10）：
  - `auto.board.patch`（info）：每次 patch 成功写一条，含 cardId 后 4 位、`sequence`、是否重试。
  - `auto.board.patch-failed`：含 `code` / `msg` / 用过的 `sequence`（已有的失败日志补上 sequence）。
  - `auto.board.resend`：含触发重发的原因码（`200740` / `200750` / `message-deleted`）。
  - 不记飞书完整 ID，不记任务内容。
- 同样的单调 sequence 规则用于 bridge 写的其它 CardKit 卡（确认卡、结束提示卡的结算更新），避免同类漂移；不改它们的结算内容（A22）。

## 验收

- [ ] 先写失败测试，再实现（fake CardKit client 按调用顺序返回码）：
  - card.update 先返回 300317，第二次（sequence 更大）返回 0 → 不发新卡；store 的 sequence 等于重试用的值；pins 不变；日志一条 `patch-failed code=300317` 和一条 `auto.board.patch retry=true sequence=<值>`。
  - 300317 两次 → 不发新卡，绑定不变，sequence 不持久化；下一次 refresh 用的 sequence 大于上次重试值。
  - 200740、200750、消息已删除各一例 → 走重发（A21 流程），`auto.board.resend` 带原因码。
  - 300311 → 不重发，绑定不变，有失败日志（非本应用卡片）。
  - 其它未列出的 `code != 0`（测试用任意码）→ 不重发，绑定不变，有失败日志。
  - 单调性：stored = 5、时间派生值 = 2,500,000 → 用 2,500,000；stored = 3,000,000 → 用 3,000,001。
  - 改写 `board-update.test.ts:23`：仍然只在 `code == 0` 时持久化，但 sequence 取单调值。
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。
- [ ] Bot Arena 实测（A11）：bridge 运行中让 box 睡眠 ≥ 5 分钟再唤醒（至少两次），看板 message id 不变、群里没有新看板；日志有 `auto.board.patch` 及 sequence；若出现 300317，紧接着有 retry 成功。测试注入一次 200750 时才重发（旧卡处理见 A26）。

## 不做

- 不处理重发后旧卡的内容与按钮、点击旧卡的提示、A21 pending 列表（A26）。
- 不追查睡眠期间是谁动了卡片（只加日志，下次能定位）。

## A11 需重跑的场景

box 睡眠 / 唤醒后的看板刷新（r5 时间线那类）；任一看板按钮点击后的原地更新。
