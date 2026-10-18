# A23 — 时间表支持「今天/明天/后天 HH:MM」与周期起点；提示词给绝对写法；提案被拒写 `auto.rejected`

Status: ready-for-agent
Severity: **high**（A11 r5 @ Bot Arena 2026-10-18 15:05 实测：「今天 15:50 运行一次」被拒，用户只看到「无法解析时间表。」；这是最常见的中文一次性说法，属于自然语言创建的核心路径）
Blocked by: —（代码基准 `5552726` + A22；只改 `command.ts` / `proposal.ts` 与纯函数测试，不碰卡片 / 看板）
Track: 推到现有 code 分支 `feat/automations-v2`（PR #49），**#49 合入前完成**，不开新 PR
Spec: [../../automations.md](../../automations.md) §2（时间输入形式、bare `HH:MM` 规则、周期起点）、§3（自然语言提案）、§10（`auto.rejected`）、User story 1/2

## 场景（A11 r5，真实触发，2026-10-18 15:05 UTC+8）

群成员 @bot：「今天 15:50 运行一次 …名称「R4空结果」」。Grok 的提案是 `{"taskType":"agent","schedule":"今天 15:50",…}`。bridge 拒绝提案，群里出现一条独立的「无法解析时间表。」。日志里没有任何 `auto` 事件，`auto.rejected` 也没有，拒绝只能在聊天里看到。（「确认前已说已提交」的部分见 [A24](A24-no-claim-before-confirm.md)。）

**证据（脱敏）**：用户消息 om_…cf5b；拒绝消息 om_…931d。临时测试（head `5552726`，不在仓库里）：

```
"今天 15:50"         REJECT invalid-schedule
"明天 09:00"         REJECT invalid-schedule
"15:50"              REJECT invalid-schedule
"2026-10-18 15:50"   OK
"45 分钟后"          OK
```

同一会话里 Grok 产出的 15 个时间表，只有「今天 15:50」失败；其余是「N 分钟/小时后」、`every…`、`每天…`。

## 触发

任何「今天/明天/后天 HH:MM」或单独「HH:MM」作为一次性时间表。

另一个理论触发（无真实触发）：「明天 15:40 开始每 10 分钟，到明天 16:05」。语法不能表达周期起点，`startAt` 恒为 now，模型只能写 `every 10m 15:40-16:05 until <明天> 16:05`，结果**今天** 15:40–16:05 也会触发。

## 根因（`5552726`）

1. **语法缺口**：`src/automations/command.ts:150-166` `parseRelative` 只认 `in Nm/Nh`、`N分钟(后)`、`N小时(后)`；`:168-179` `parseAbsolute` 只认 `YYYY-MM-DD HH:MM`（可选 `at`）。
2. **提示词没给绝对写法**：`src/automations/proposal.ts:17` 的示例只有「10 分钟后、每个工作日 09:00、every 30m 09:00-18:00 until 2026-12-31」，也没说绝对时刻该怎么写。模型照抄用户原话「今天 15:50」是可预期的。
3. **被拒不留日志**：提案被拒时 `command.ts:446-449`（`:448`）只 `replyAuto`，不写结构化日志。Spec §10 的 `auto.rejected` 目前只在用户点「否」时记（`dispatcher.ts:480`）。
4. **周期起点**：`command.ts:484-485` / `:203-206` 把 `startAt` 固定为 now。

## 要做

**(a) 一次性日期 + 时刻**（Spec §2，按 `automations.timezone` 换算，不依赖主机时区）
- `今天 HH:MM`、`明天 HH:MM`、`后天 HH:MM`（`HH:MM` 可写 `H:MM`，允许全角冒号「：」）→ 该本地日期的该时刻。
- `今天 HH:MM` 已过（≤ now）→ 拒绝，原因写「今天 HH:MM 已过」，并给示例（`明天 HH:MM`）。**不**自动顺延到明天。
- 单独 `HH:MM` = **下一次出现**：今天该时刻晚于 now 就是今天，否则（≤ now）是明天。
- 换算后照常走 §2 下限：距 now 不足 10 分钟（reminder）→「最早 10 分钟后。」。单独 `HH:MM` 落在今天且不足 10 分钟时**也拒绝**，不跳到明天（避免把「15:12」悄悄变成明天 15:12）。
- DST 沿用 §2：不存在的本地时刻顺延到下一个有效分钟，重复的取第一次。

**(b) 周期起点**（决定：**支持**。`startAt` 已是落库字段，只需让语法能写它）
- 周期时间表可加前缀 `从 <日期> [HH:MM] 起`，`<日期>` 为 `今天|明天|后天|YYYY-MM-DD`；英文同义 `from YYYY-MM-DD [HH:MM]`。省略 `HH:MM` 时起点为该日 00:00（任务时区）。
- `startAt` = 该本地时刻换算的 UTC；第一次 fire 是 `≥ max(now, startAt)` 的第一个规则时刻。
- 起点不能早于 now 所在的今天；`startAt` ≤ 1 年后；`endAt − startAt ≤ 1 年`（§2 已有）；`endAt ≤ startAt` → 拒绝。
- 例：`从 明天 15:40 起 every 10m 15:40-16:05 until 2026-10-19 16:05` 只在 10-19 触发。
- 无法识别的起点写法 → 拒绝，原因写「无法识别开始时间」并给上面的示例；**不**忽略起点、从今天开始。
- 确认卡在时间表行之后写「从 YYYY-MM-DD HH:MM 开始」（仅当 `startAt` > now 时）；接下来 N 次按 `startAt` 计算。

**(c) 提示词**（`proposal.ts:17`）
- 示例补上：`2026-10-18 15:50`、`今天 15:50`、`明天 09:00`、`从 明天 15:40 起 every 10m 15:40-16:05 until 2026-10-19 16:05`。
- 写明：一次性绝对时刻用 `YYYY-MM-DD HH:MM` 或 `今天/明天/后天 HH:MM`；周期任务从某天开始时用 `从 <日期> [HH:MM] 起` 前缀。
- 正文措辞的约束在 A24，这里不改。

**(d) 提案被拒写 `auto.rejected`**（Spec §10）
- 字段：`reason`（如 `invalid-schedule`、`below-floor`、`past-time`、`too-far`、`invalid-start`）、`source=proposal`（`/auto new` 走同一校验时为 `source=command`；用户点「否」保持现状，`source=confirm-card`）。
- 不记任务原文、不记原始时间表文本、不记飞书 ID。

## 验收

- [ ] 先写失败测试（A0a 的 `parseScheduleText` 纯函数表驱动，注入 `now()`，宿主时区设为 UTC，任务时区 `Asia/Shanghai`；另加一组非上海时区如 `America/New_York`）：
  - now = 2026-10-18 15:05 +08:00：`今天 15:50` → 2026-10-18 15:50 +08:00；`明天 09:00` → 10-19 09:00；`后天 9:00` → 10-20 09:00；`今天 15：50`（全角冒号）同第一条。
  - `今天 15:00`（已过）→ 拒绝，原因含「已过」。
  - `今天 15:12`（< 10 分钟）→「最早 10 分钟后。」。
  - 单独 `15:50` → 今天 15:50；单独 `15:00` → 明天 15:00；单独 `15:12` → 拒绝（下限），**不**是明天。
  - `从 明天 15:40 起 every 10m 15:40-16:05 until 2026-10-19 16:05` → `startAt` = 10-19 15:40，`nextFires` 第一项 10-19 15:40，今天无 fire。
  - `从 昨天 起 …`、`从 2026-10-17 起 …`（早于今天）、`endAt ≤ startAt`、起点 > 1 年 → 各自明确拒绝。
- [ ] 集成：Grok 提案 `schedule:"今天 15:50"` 生成确认卡，时间表行显示 `一次性 2026-10-18 15:50`。
- [ ] 集成：非法提案（`今天 15:00`）→ 日志一条 `auto.rejected reason=past-time source=proposal`，不含任务文本与时间表原文。
- [ ] 提示词快照测试：包含 `今天 HH:MM` / `YYYY-MM-DD HH:MM` / `从 … 起` 的示例。
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。
- [ ] Bot Arena 实测（A11）：@bot「今天 HH:MM 提醒…」（HH:MM 取 now + 20 分钟）出确认卡，时间表行是当天的绝对时刻，到点触发；@bot「明天 HH:MM 开始每 10 分钟提醒…，到明天 HH:MM 结束」出确认卡，卡上写「从 <明天> HH:MM 开始」，今天不触发（看 `auto.fire` 日志与 status 文件 `nextFires`）；@bot「今天 <已过的时刻> 提醒…」→ 群里看到拒绝原因，日志有 `auto.rejected`。

## 不做

- 不改回复正文的投递顺序与措辞（A24）。
- 不改确认卡的「接下来 N 次」标签（A27）。
- 不支持「下周一」「月底」等更多日期词（以后再议）。

## A11 需重跑的场景

r5 的「今天 15:50 运行一次」（时刻换成 now + 20 分钟）；新增「明天开始」的周期场景。
