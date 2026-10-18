# Spec: In-group automations（群内定时自动化）

Status: ready-for-agent · Docs track: PR #44（本分支）· Code track: draft PR #49（`feat/automations-v2`，from `master@d056198`；取代已关闭的 #45），tickets claimed from #44, one ticket per session
Tickets: [`automations/tickets/`](automations/tickets/README.md)
Baseline: `master@d056198`（run-reliability 与 link-recovery PR #47 均已合入）。只依赖 link-recovery 的**契约**：fire 结果与通知的投递复用 **Outbox**（turn journal：stage → send → delivered → recovery 时 redeliver），link down / recovered 信号来自 **FeishuLink**；**永不**使用 **Continuations**（fire 被中断不提供“继续”，也不自动续跑）。
Decisions: grill 2026-10-16 锁定 ADR-001..012；grill 2026-10-17 新增 ADR-013..015（补跑规则、larkent-monitor 路线、status block v1），ADR-013 **取代** ADR-004；用户 2026-10-17 决定 ADR-016..020（见 Resolved decisions，取代原 Open questions）；用户 2026-10-18 决定 ADR-021（短段墙钟重算、60 秒准点标注、agent 任务重叠跳过）。见文末 Decision log。本文只写行为、决策、边界与验收；代码锚点（file:line，已对 `master@d056198` 核对）写在各 ticket。

---

## Problem Statement

群成员想让 bot 在某个时刻或按周期做事：到点提醒一句话，或到点跑一次 agent 并把结果发回群里。现在只能每次手动 @bot。约束：

- 群里的人工对话不能被打扰、排队或混入自动化内容。
- agent 默认 full 权限、自动批准工具；profile 的 lark-cli 同时持有 bot 与 owner 用户身份（含加/减群成员）。自动化把它变成“无人值守、延迟、重复”的能力。
- 飞书卡片只能由发送身份更新；多个 bot 共处一群；飞书**没有**置顶/取消置顶事件（实测，见 Further Notes）。
- 承载 bridge 的进程会停（崩溃、重启、主机睡眠）或 link 断开，到点的 fire 会错过。Larkent 自己在重启 / link 恢复时按同一规则补跑；私有的 larkent-monitor（只服务常驻的 Grok Bot box）读取看板里的机读 status block，发现 miss 后唤醒 box。两条路径都按 fire key 幂等，同一 fire 只执行一次。

## Solution

- 群里 @bot，用自然语言或 `/auto new` 创建 **automation**：**一次性**或**周期**（iPhone 日历模型），任务类型为 **reminder**（纯文本，无成本）或 **agent 任务**（agent task，跑一次 agent prompt）。
- bridge 校验时间表；缺结束时间时发**确定性脚本卡**索要；齐全后发**确认卡**（逐字列出类型、时间表、时区、接下来 3 次触发、结束时间、任务原文、执行身份），群里任何人点「是」即生效。
- 到点：reminder 发一条文本；agent 任务在后台新开 session 跑一次，结果发为一条 **result post**，可在其话题里追问。reminder 的 fire 互不阻塞。同一 agent 任务上一次未结束时，本次到点跳过：不并发、不排队、不发群消息。
- 每个有自动化的 bot 在群里置顶一张自己的 **board**：每任务一行（内容、下次触发、结束），带【暂停】【删除】按钮，任何人可点；卡内含可见的机读 **monitor hook** 文本块。被取消置顶会在下次看板更新时重新置顶。
- `/auto` 列表命令作为备用查看入口。
- 周期任务到期即删除，无续期提醒、无保留。
- 错过的 fire（计划时刻已过、未执行、未暂停）在 **24 小时内**补跑**恰好一次**（按 fire key 幂等），消息注明“补跑，原定 HH:MM”；同一任务错过多个时刻只补最近一个。没补的每个时刻都留痕：看板逐条列为“已错过”（含原定时间）、群里发一条通知、本地日志记一条。按设计 miss / 补跑**不应发生**，所以发生了就必须可见（ADR-016..019）。

## User Stories

1. As a group member, I want to say “10 分钟后提醒我交周报”, so that I get a one-shot reminder without learning syntax.
2. As a group member, I want relative input converted to an absolute time and shown on the confirm card, so that I know exactly when it fires.
3. As a group member, I want “每个工作日 9:00 提醒站会，到年底结束”, so that routine reminders run themselves.
4. As a group member, I want weekly schedules on chosen weekdays at one or more times, so that I can match my team rhythm.
5. As a group member, I want “每 30 分钟，9:00–18:00” style schedules, so that I can poll something during work hours.
6. As a group member, I want a window that crosses midnight (22:00–02:00), so that night shifts are covered.
7. As a group member, I want an agent task (“工作日 9 点汇总昨天的 issue”), so that the bot does real work on schedule.
8. As a group member, I want the confirm card to say whether it is a reminder or an agent task, so that I know whether it costs anything.
9. As a group member, I want a scripted card asking for an end date when I forget one, so that recurring tasks never run forever.
10. As a group member, I want recurring tasks capped at one year and one-shots at one year ahead, so that forgotten tasks die.
11. As a group member, I want too-frequent schedules rejected (reminder < 10 min, agent < 1 h) with a clear message, so that the group isn't spammed.
12. As any group member, I want to confirm a draft with one tap, so that creation is quick.
13. As a group member, I want each agent fire to start a fresh session, so that runs don't leak into each other.
14. As a group member, I want a reminder fire not to wait on another fire, and an agent task whose previous run is still going to skip this slot (board trace and local log, no group post) instead of stacking a second run, so that the schedule stays honest.
15. As a group member, I want automation runs never to block or merge with human chat, so that conversation stays responsive.
16. As a group member, I want exactly one result post per agent fire and to follow up in its thread, so that results are tidy.
17. As a group member, I want a pinned board listing this bot's tasks with next fire and end, so that I can see what will happen.
18. As any group member, I want Pause and Delete buttons on the board, so that anyone can stop a noisy task.
19. As a group member, I want the board re-pinned if someone unpins it, so that it stays findable without deleting tasks.
20. As a group member, I want `/auto` to list tasks when the board is out of sight, so that there is a fallback.
21. As a group member, I want weekday schedules to state they ignore holiday swaps, so that I'm not surprised on 调休 days.
22. As a group member, I want times to follow the profile timezone with sane DST handling, so that 9:00 stays 9:00.
23. As a group member, I want an expired recurring task to disappear, so that the board stays clean.
24. As a group member, I want a fire missed while the bridge was down to be caught up once within 24 h with “补跑，原定 HH:MM” noted, and every fire that was not caught up listed as “已错过” with its original time on the board and announced once in the chat, so that I still get recent reminders, never stale ones, and never silently lose one.
25. As an operator, I want a restart, a link recovery and a monitor wake to never fire the same fire key twice, whichever comes first, so that duplicates don't happen.
26. As an operator, I want fire results delivered through the link-recovery outbox, so that a failed send is redelivered after recovery.
27. As an operator, I want automation runs blocked from personnel/org operations by a bridge whitelist, so that an unattended run can't add or remove members.
28. As an operator, I want a machine-readable status block in the board card (per-item short `id`, `paused`, card-level `updatedAt`), so that larkent-monitor can detect a miss and wake the always-on box after it.
29. As an operator, I want that block to contain no Feishu IDs, task content or creator, so that nothing sensitive leaks.
30. As an operator, I want structured log events for create/confirm/fire/missed/result/policy-guard, so that I can audit behaviour.
31. As an operator, I want the feature off by default per profile, so that rollout is controlled.
32. As an operator, I want reminders to ship before agent tasks, so that the zero-cost path proves the scheduler first.
33. As a maintainer, I want schedule parsing and next-fire computation as pure functions with an injected clock, so that they are table-testable.
34. As a maintainer, I want an E2E in Bot Arena using a fake clock or test-only floor override, so that tests respect the 10-minute floor in production.
35. As a group member, I want removing the bot from the group to stop its tasks there, so that nothing fires into a chat the bot left.
36. As an operator, I want a woken box that finds the fire already ran to stay silent and report to nobody, so that a monitor wake never produces noise.
37. As an operator, I want every missed fire and every catch-up written to a permanent local automations log, so that a miss that should never happen can be investigated afterwards.

## Implementation Decisions

### 1. Glossary（随代码 PR 同步并入 CONTEXT.md，见 ticket A0b）

- **automation**：绑定一个群和一个 bot profile 的持久任务；`taskType` 为 `reminder` 或 `agent`（agent 任务）。字段不叫 `kind`：CONTEXT 里 **agent kind**（`AgentKind`）已指 claude / codex / … 适配器。
- **one-shot**：单个绝对 UTC 时刻，最远 1 年后。
- **recurring**：规则 + IANA 时区 + 起止 UTC 时刻；必须有结束，最长 1 年。
- **reminder**：到点发纯文本，不跑 agent；最小提前量/间隔 10 分钟。
- **agent 任务**（agent task）：到点跑一次 agent prompt；最小间隔 1 小时。不叫 “agent kind”。
- **fire**：时间表上的一个绝对时刻。
- **automation id**：每 profile 自增的短编号，与 `/auto` 列表编号相同；**永不复用**（删除后编号不回收），不是飞书 ID。
- **fire key**：`id` + 计划时刻 `nextFireAt`（UTC 毫秒），如 `3@1792218600000`；跨重启、link 恢复与 monitor 唤醒幂等。
- **started**：fire key 已在执行前持久化；从此该 fire 视为“已执行”，后续投递失败交给 Outbox，不再按补跑处理。
- **automation run**：没有触发消息、scope 为 `auto:<id>:<fireAt>` 的 run。CONTEXT 中 **run** 放宽为“一条飞书消息或一次 fire”。
- **result post**：一次 agent fire 的唯一权威消息；**bridge-owned final reply** 扩展到 fire；经 Outbox 投递。
- **follow-up thread**：以 result post 为根的话题，续接该 fire 的 session。
- **miss rule**（无固定宽限）：一项任务 missed 当且仅当 `!paused && nextFireAt > 0 && now > nextFireAt && lastFireAt < nextFireAt`。monitor 与 Larkent 使用同一条规则。
- **catch-up**（补跑）：对 missed 的 fire，在计划时刻后 24 小时内执行恰好一次（按 fire key 幂等），消息注明“补跑，原定 HH:MM”；同一任务只补最近一个；本地 automations log 单独记一条 catch-up。标注例外：fire 时间晚于 `nextFireAt` 不超过 60 秒，且这次没有更早的漏跑，则执行但不标「补跑」（只影响标注，不改变 miss rule，也不改变 24 小时上限）。
- **已跳过**（skipped fire）：同一 agent 任务上一次 run 尚未结算时，本次到点不执行，包括 link down 时到点（不排队到恢复后再跑）。看板一行“已跳过 原定 …”，保留 24 小时后从看板移除；automations log 永久记原定时刻与原因；不发群消息。`lastStatus` 仍为进行中的那次。
- **已错过**（missed fire）：最终不执行的计划时刻（超 24 小时，或同任务被更近的一次补跑取代）。每个都留痕：看板一行“已错过 原定 …”、群内一条通知、本地 automations log 一条（ADR-016）。
- **missed**（计数）：已错过的 fire 数；补跑成功的不计入。
- **automations log**：profile 数据目录下的本地追加日志，记录每个已错过时刻与每次补跑；**永久保留**（不随任务删除或 fire 历史截断而清理）；不含任务正文与飞书 ID。
- **expire**：周期任务过结束时刻后删除。
- **scripted card**：bridge 确定性渲染的固定卡片（缺结束时间、校验失败），不经 agent。
- **draft**：等待确认的自动化，TTL 24 小时。
- **board**：每 bot 每群一张置顶卡；行 + 暂停/删除按钮。
- **monitor hook** / **status block**：board 内可见的机读文本块（“note”= 现有 markdown 元素 + `text_size: 'notation'`）；事实源为本地 status 文件。
- **larkent-monitor**：私有的外部监视器，只服务常驻的 Grok Bot box；路线为 Cloudflare Worker 扫描看板 → wake webhook 唤醒 box；不涉及 GitHub Action。其实现不在本仓库。
- **scheduler**：按 `nextFireAt` 产生 fire 的定时器，归 profile 所有。每段最多睡 60 秒，醒来按墙钟重算到期项。启动、短段醒来、link 恢复与本机唤醒入口执行同一补跑规则；与 backfill 无关。
- **automation creator**（`createdBy`）：促成创建那条消息的人；**bot owner** 即现 `isCreator()`，改名 `isBotOwner()`（避免与 creator 混淆）。

### 2. Time model（ADR-001/002/003）

- 相对时间只是输入；落库为绝对时间。one-shot 存 UTC 时刻；recurring 存规则 + IANA 时区 + `startAt` / `endAt`（UTC），并持久化 `nextFireAt`、`lastFireAt`。
- `lastFireAt` 记录**最后一次 started 的计划时刻**（不是实际执行时刻）；补跑 12:30 的 fire 后 `lastFireAt` = 12:30。`nextFireAt` 在该 fire started 或被判定为超 24 小时放弃之前**不推进**，因此停机期间看板上的 `nextFireAt` 就是被错过的时刻。无后续触发时 `nextFireAt = 0`。
- 规则：
  - `daily` 若干时刻；`weekday`（周一至周五，v1 不计调休，卡片明示）；`weekly`（选定星期 + 若干时刻）。
  - `every N minutes|hours`，N 分钟 ≥ 10；可选时间窗 `[from, to)`，允许跨午夜（归属开始日）。
  - 无每日次数上限。
- 下限：reminder 最小提前量与间隔 10 分钟；agent 最小间隔 1 小时（多时刻规则按相邻时刻差校验）。one-shot ≤ 1 年后；recurring `endAt − startAt ≤ 1 年`。
- 时区：profile 设置 `automations.timezone`（IANA），未设则 `Asia/Shanghai`；创建时写入任务；不依赖主机时区。DST：不存在的本地时刻顺延到下一个有效分钟；重复的本地时刻只取第一次。
- 缺 `endAt` 的 recurring：bridge 发 scripted card 索要（按钮给常用选项 + 文本输入），收到前不出确认卡。
- 到期：最后一次 fire 后或过 `endAt` 即删除，看板移除该行；无续期提醒、无保留。例外：one-shot 未补跑（已错过）时 `nextFireAt = 0`、看板显示“已错过”，24 小时后才按到期删除（ADR-017）。

### 3. Creation and confirmation

- 任何能 @bot 且通过该群 access 的**人**可创建；bot 消息与 automation run 产生的提案一律忽略（防自我复制）。
- 自然语言：agent 产出结构化提案（含任务类型、时间表、任务文本）；群、scope、创建者取自当前 run 上下文。bridge 校验后建 draft，发确认卡；内容与落库逐字一致。
- `/auto new <时间表> | <名称> | <任务>` 走同一张卡；`|` 只切前两个；任务类型默认 reminder，`/auto new agent ...` 指定 agent 任务。
- 创建时落库：群绑定、`createdBy`、名称、任务原文、时区，以及 agent 任务的 cwd 快照（`auto:` scope 没有自己的工作区，fire 时不能再按 scope 解析 cwd）。
- 确认卡按钮使用**新签名 action**：绑定 draft、群、动作、一次性 nonce、TTL；不绑 operator、不要求运行中 run；授权 = 回调点击者为人 + 通过该群 access；只接受 bridge 登记过的卡片。仿照 interruption notice 的签名 action（不绑 operator），**不**沿用绑定 operator + run 的 bridge callback 签名。
- 编辑：v1 不提供原地编辑；删除后重建。

### 4. Scheduler, fire and catch-up（ADR-006/013/021）

- scheduler 归 profile，跨 `/reconnect`、bridge swap、进程重启存活。
- **短段重算**（ADR-021）：定时器每次最多睡 60 秒，醒来按墙钟重算到期的 fire 与到期删除。不使用单段长达数十天的 `setTimeout`。进程睡眠或墙钟前跳后，下一段醒来即按下面的补跑规则处理到期项。link 仍 down 时不开始发送（见下）；agent 任务的重叠跳过不依赖 link，到点即跳过，不把该次留到恢复后再跑。
- 正常路径：到达 `nextFireAt` 时开始该 fire。
- **准点标注**（ADR-021）：fire 时间晚于 `nextFireAt` 不超过 60 秒，且该次没有更早的漏跑，视为准点，不加「补跑」标注。晚于 60 秒且按 miss rule 确实错过，则按补跑处理。这只决定标注；miss rule 仍无固定宽限，24 小时补跑上限不变。
- **幂等**：开始执行前先原子持久化 fire key 为 started（并写 `lastFireAt`），然后才发送或启动 agent；同一 fire key 不再执行。started 之后的投递失败只走 Outbox redeliver，不按补跑重来。已开始的 fire key 只保留计划时刻落在最近 48 小时内的条目，更早的在调度醒来时清除。
- **补跑规则（Larkent 自身执行，不依赖 monitor，也不留给实现者自行决定）**，在以下时机运行，规则完全相同：
  1. 进程启动 / 重启；
  2. FeishuLink 由 down 恢复（`link.recovered`）；
  3. 本机唤醒入口（见 §7，供 monitor 唤醒的 box 使用）；
  4. 短段定时器醒来（墙钟重算）。

  对每个按 miss rule 判定 missed 的任务：
  - 若计划时刻距 `now` ≤ 24 小时：执行**恰好一次**补跑（fire key = `id` + 被错过的计划时刻），reminder 文本与 agent result post 都注明“补跑，原定 HH:MM”（按任务时区）；agent 的提示词附一行迟到说明；automations log 另记一条 catch-up（ADR-019）。
  - 同一任务若错过多个计划时刻，只补跑 24 小时内**最近**的一个；其余每个都是“已错过”（ADR-016）。
  - 若 > 24 小时：不执行，该时刻为“已错过”；`lastStatus = missed`；推进到下一时刻。one-shot 则 `nextFireAt = 0`，24 小时后按到期删除（ADR-017）。
  - **已错过必须留痕**（每个时刻）：`missed` +1；看板列一行“已错过 原定 YYYY-MM-DD HH:MM”；群内发一条通知（同一次补跑判定中同任务的多个已错过时刻合为一条，逐个列出原定时间；经 Outbox 投递，投递键由任务 id + 时刻派生）；automations log 写一条。
  - 补跑后 `nextFireAt` 从 `now` 重算到下一个未来时刻；若已无后续（one-shot 或过 `endAt`），按 §2 到期删除。
  - paused 的任务不补跑；恢复后从 `now` 重算，不补暂停期间的 fire。删除的任务永不补跑。
- **任一路径先到都安全**：Larkent 自己重启并补跑后，monitor 再唤醒 box，box 按 fire key 查到已 started → 静默，不对任何人报告；反之亦然。并发到达时以 fire key 的持久化为准，只有一个执行。
- **link down 时到点**：不开始该 fire（不 stage、不计 started），该 fire 保持 missed 状态；link 恢复时按上述补跑规则处理（≤ 24 小时执行一次；超过 60 秒准点窗口时注明“补跑，原定 HH:MM”）。
- 每次 fire 独立：新 session、scope `auto:<id>:<fireAt>`。reminder 不等待、不因其他 fire 未结束而跳过。同一 agent 任务上一次未结算则跳过本次（ADR-021）：不启动第二次 run、不排队、不发群消息；看板该条显示“已跳过 原定 YYYY-MM-DD HH:MM”；automations log 记原定时刻与原因。`lastStatus` 与 `lastFireAt` 保持为进行中的那次，以便结算。不进入群 pending queue，不与人工消息合并。
- 并发：不同任务的 fire，以及 reminder，立即启动自己的 session，**不经过 profile 进程池、不设并发上限、永不因池满失败或排队**（以后可收紧）；人工 run 也不会排在自动化之后。同一 agent 任务不重叠（见上）。现有 run 执行路径在 reconnect 暂停时拒绝、并经过进程池，所以 agent 任务需要一条独立的执行路径（A8）。
- `auto:` scope 的 run 不进入启动时孤儿回收的 Continuation / 继续通知流程。
- 每次 fire 前校验：bot 仍在群内；否则见 §8。

### 5. 任务类型（ADR-005、ADR-020）

- **reminder**：发一条文本消息“⏰ 名称：任务文本”（补跑时追加“（补跑，原定 HH:MM）”）；无 agent、无成本。先上线。
- **投递**：每次 fire（以及每条已错过通知）在 Outbox（turn journal）里有自己的条目，`turnId` / `deliveryId` 由 fire key 派生（≤ 50 字符，不能靠截断区分）；journal 的 reply 需要 `replyTo`，fire 没有触发消息，须为顶层投递定义取值。
- 投递去重：Feishu uuid 去重只覆盖 1 小时；超过 1 小时的回读按 `parent_id === replyTo` 匹配，顶层 fire 无 parent，**无法回读**。“发出但回执丢失且超过 1 小时才重投”可能重复一次：理论风险，现实中没有触发通道，**接受、不开 ticket、不做处理**（ADR-018）。
- **agent 任务**：在创建时快照的 cwd 下、用该 profile 自己的 agent 跑任务文本；结果作为 result post 一次性发出（无 Typing、无流式卡、无 CoT）；页脚提示“在本消息话题里追问”；补跑的 result post 注明“补跑，原定 HH:MM”。硬超时与默认空闲上界一致（15 分钟）。补跑上限同样是 24 小时，不另设更短上限（ADR-019）。
- agent 已自行发到本群：沿用 `skip-cli-already-sent`，fire 记 delivered-by-agent。
- 追问：result post 话题里的回复续接该 fire 的 session。现有 scope 计算把普通群回复映射到群 scope、话题群映射到 `chatId:threadId`，需要新增“result post 根消息 → `auto:` scope”的映射。

### 6. Safety for agent 任务

- 优先仅 bot 身份（lark-cli 身份预设 `bot-only` 的**按 run 覆盖**；现在身份预设是 profile 级），系统提示词使用自动化变体。
- bridge 层 **tool whitelist**：人事/组织能力（建群、成员增删、退群、群设置、通讯录、人事）或请求用户身份 → 立即停止，`StopRequest` 新增 `policy-guard`，outcome `interrupted(policy-guard)`，群内通知，自动化暂停。审计日志脱敏。
- 诚实边界：agent 有完整 shell，这是纵深防御，不是安全边界；确认卡如实说明。**whitelist 与仅 bot 身份验证前，agent 任务不得在线上开启**；reminder 不受此限。

### 7. Board（ADR-007）与 monitor hook（ADR-008）

- 每 bot 每群一张卡，只含本 bot 的任务；同数据根内锁 + 租约保证单写者；去抖更新。
- 行：名称/内容摘要、任务类型、下次触发、结束时间、状态；按钮【暂停/恢复】【删除】，**群里任何人可点**（暂无权限校验；被滥用再议）。点击后卡片原地更新。
- 已错过：每个已错过时刻单列一行“已错过 原定 YYYY-MM-DD HH:MM”，在看板上保留 24 小时（与 ADR-017 的 one-shot 保留期一致），之后从看板移除；automations log 永久保留。
- 已跳过：agent 任务因上一次未结算而跳过的时刻单列一行“已跳过 原定 YYYY-MM-DD HH:MM”，同样在看板上保留 24 小时；automations log 永久保留原定时刻与原因。不发群消息。
- 按钮签名：notice 式 token 是一次性 nonce + 24 小时 TTL，看板长期存在，所以按钮要么用可重复使用的签名 action（动作幂等），要么每次渲染重新签名并在 TTL 前刷新。
- link 恢复后刷新看板（订阅 FeishuLink 的 recovered 信号）。
- 置顶：无 unpin 事件，每次更新看板时查询本群 pins，若本卡不在则重新置顶；pin 失败提示一次。取消置顶不影响任务。本 bot 在群内无任务时卡片显示“暂无”并取消置顶。
- 卡片无法更新（丢失/过期）时重发并置顶，尝试取消旧卡置顶。
- **monitor hook / status block**（ADR-008、ADR-015；沿用现有 “note” 通道 = markdown 元素 `text_size: 'notation'`）：卡内一个**可见**文本块（HTML 注释与按钮 value 对读者不可见），一行 JSON，`v` 仍为 1：

```json
{"v":1,"bot":"<display name>","updatedAt":0,"items":[{"id":3,"paused":false,"nextFireAt":0,"lastFireAt":0,"lastStatus":"ok|missed|failed|running","endAt":0,"missed":0}]}
```
  - 时间均为 UTC 毫秒。`id` 是 §1 的短编号（与 `/auto` 编号相同），**永远不是飞书 ID**。`updatedAt` 为卡片级，每次渲染写入。`nextFireAt = 0` 表示无后续触发。
  - 不含飞书 ID、任务内容、创建者。事实源为 profile 数据目录下的本地 status 文件（随 scheduler 原子写），卡片由其渲染。已错过的逐条时刻只在看板可见行与 automations log 中，status block 字段不变（仍是 `missed` 计数）。
- **larkent-monitor 契约**（monitor 私有，只服务常驻的 Grok Bot box；其他 PC 不在范围内）：
  - 只从置顶看板卡的 status block 读状态；路线为 Cloudflare Worker 扫描 → wake webhook 唤醒 box；不涉及 GitHub Action。
  - 按 §1 的 miss rule 判定；对每个 fire key（`id` + 当时的 `nextFireAt`）**至多唤醒一次**。
  - monitor 在 miss **之后**唤醒，不做预唤醒。
- **本机唤醒入口**（Larkent 暴露，被唤醒的 box 调用）：一个新的 CLI 子命令，给定 fire key：Larkent 未运行则启动它（启动补跑生效）；在运行则通知运行中的进程（目前没有稳定的进程间通道，UI server 的 token 每进程随机，不能复用；传输方式在 A5 定义）。若该 fire 已 started → 无输出、不发任何消息、不向任何人报告；否则按 §4 补跑规则处理，补跑恰好一次，> 24 小时按“已错过”留痕。该入口幂等，可重复调用。
- `/auto`：列出本群本 bot 的任务（任何人）；`/auto pause|resume|delete <编号>` 与按钮等价。

### 8. Lifecycle edges

- bot 被移出群或群解散：订阅飞书事件 `im.chat.member.bot.deleted_v1` 与 `im.chat.disbanded_v1`（需在开放平台为应用开通事件订阅），或发送被拒为“不在群内”（发送/回复错误码 230002 “The bot can not be outside the group”）或“群已解散”（232009）：该群任务删除，看板不再写；日志一条。需要一个明确的 not-in-chat 错误类，不能复用“消息已不存在”的判断。
- 私聊：不支持（回复“仅支持群”）。
- 无每群 / 每人硬限额（ADR-009）；周期任务的确认卡写出“约每月 N 次”。一次性不写每月次数：只显示该次触发时刻，或写「共 1 次」（A17）。

### 9. Storage and rollout

- 每 profile 一个 automations 文件，`schemaVersion: 1`，原子写（Windows / macOS / Linux），supervisor 持有（与 turn journal 同级）；未来版本拒绝加载且不覆盖；旧代码忽略。fire 历史只保留每任务最近若干条；automations log 是单独的永久文件，不截断。
- profile 设置为顶层 `automations` 块（需新的 normalizer；现有 `reliability` 块加载时整体丢弃，不能放在那里）：`automations.enabled`（默认关）、`automations.agentTasks`（agent 任务单独开关，默认关）、`automations.timezone`（IANA，默认 `Asia/Shanghai`）。

### 10. Observability

结构化事件：`auto.draft`、`auto.confirmed`、`auto.rejected`、`auto.fire`、`auto.missed`、`auto.catch-up`（含原定时刻与触发来源：startup / link-recovered / wake / confirm）、`auto.skipped`（agent 任务重叠跳过：原定时刻与原因；不发群消息）、`auto.wake.already-started`（静默，仅本地日志）、`auto.result`（outcome）、`auto.paused`、`auto.deleted`、`auto.expired`、`auto.policy-guard`、`auto.board.repin`、`auto.removed-from-chat`。不含任务正文。`auto.missed`、`auto.catch-up` 与 `auto.skipped` 同时写入永久的 automations log（ADR-016/017/019/021）。确认卡点击后的 `nudge()` 使用触发来源 `confirm`；automations log 读回接受 `confirm`。

### 11. Backfill fix (F20)

backfill 从 scope 推导 chat id 时，`auto:` 与 `meeting:` scope 永不进入 chat mode 查询。

## Testing Decisions

- 只测外部行为：群里看到什么（消息、卡片状态、置顶）、落库与 hook 文本。用 recording channel、scripted CLI、fake executable、fake clock。
- 最高测试缝：channel 级“推进时钟 → 群里可见输出 + 日志/状态文件”；与 run outcome / turn journal 集成测试同层。时间表解析与下次触发为纯函数，注入 `now()`，在 UTC 宿主时区跑表驱动用例（DST、跨午夜窗口、下限、1 年上限）。
- 真飞书层：`e2e/test-bridge/`（默认 fake CLI，硬围栏）在 Bot Arena 跑；使用 fake clock 或**仅测试可用**的下限覆盖，不使用“1 分钟后”的生产输入。证据脱敏，不含任何 ID。
- 补跑与幂等：fake clock 表驱动覆盖 miss rule 边界（`now == nextFireAt` 不算 miss、paused 不算、`lastFireAt == nextFireAt` 不算）、24 小时边界、多个错过时刻只补最近一个且其余每个都有看板行 / 群通知 / 日志、重启 / link 恢复 / 唤醒入口任意顺序与并发到达都只执行一次。短段重算：40 天后的一次性任务每段 ≤ 60 秒且不空转；墙钟前跳 2 小时后下一段醒来补发并按准点规则标注。准点标注：晚 50ms 与晚 59s 不标补跑，晚 61s 且确实错过则标补跑。agent 任务重叠：上一次未结算时跳过本次，看板与日志留痕，`lastStatus` 不被覆盖。started fire key 超出 48 小时后清除。
- 不设延迟/耗时类验收。

## Out of Scope

p2p 自动化；命令型自动化；超出 Outbox 1 小时 uuid 窗口的重复投递防护（ADR-018）；修复 larkent-monitor 本身让 miss 不发生（本仓库外的后续工作）；节假日调休日历；原地编辑；miss rule 上的固定宽限（补跑**标注**的 60 秒准点窗口见 ADR-021，不改变“什么算错过”）；超过 24 小时的补跑；续期提醒；硬并发与每群限额（可后续收紧）；跨群创建；fire 之间携带上次结果；跨 bot 共享看板 / 多维表格台账；附件/图片任务；larkent-monitor 本身的实现（私有，不在本仓库）；monitor 服务常驻 Grok Bot box 以外的电脑；monitor 预唤醒（monitor 只在 miss 之后唤醒，见 ADR-014）。

## Further Notes

- Bot Arena 实测（2026-10-16）：bot 可发交互卡、im/v1/pins 置顶与取消、PATCH 原地更新（需 `update_multi`）；只读第三方应用可列 pins 并读卡片，但读到的是简化渲染——HTML 注释与按钮 value 丢失，note 文本完整；pin/unpin 不产生事件或系统消息；按钮回调未验证（需运行 test bridge + 真人点击）。
- 待验证：回调点击者身份可靠性；话题群中 result post / 追问行为；线上 bot 实际 scope 与仅 bot 身份可行性；多 profile 是否共用数据根。

### Resolved decisions（2026-10-17，用户确认；取代原 4 个 Open questions）

1. **多个错过时刻**（ADR-016）：同一任务停机期间错过多个计划时刻，只补跑 24 小时内**最近**的一个；其余标“已错过”。按设计 miss / 补跑不应发生，所以必须留痕：看板逐个列出“已错过”及原定时间、群里发一条通知、本地 automations log 写一条。
2. **one-shot 未在 24 小时内补跑**（ADR-017）：`nextFireAt = 0`，看板显示“已错过”，24 小时后按到期删除；本地 automations log **永久**保留这条错过记录。
3. **超出 Outbox 1 小时 uuid 窗口的重复投递**（ADR-018）：理论风险（现实中没有触发通道），不开 ticket、不做处理；在 §5 与 Out of Scope 记录。
4. **agent 任务补跑上限**（ADR-019）：保持 24 小时；每条补跑 result post 注明“补跑，原定 HH:MM”，并单独写一条本地 catch-up 日志。（reminder 补跑沿用同一措辞。）
5. **改名**（ADR-020）：新任务类型由 “agent kind” 改为 **agent 任务**（英文 agent task）；开关 `automations.agentTasks`，默认关。spec、tickets、README 全部改用新名。
6. **说明**：修好 larkent-monitor 让 miss 不再发生，是本仓库之外单独的后续工作，不在本 spec / tickets 范围。

### Decision log（2026-10-16 grill）

| ADR | 决定 | 取代 |
|---|---|---|
| 001 | iPhone 日历模型；存绝对时间 | 只存 IANA |
| 002 | 规则集与下限（reminder 10 min、agent 1 h、one-shot ≤ 1 y）；工作日不计调休 | 每天 ≤ 4 时刻、无每 N 分钟 |
| 003 | recurring 必须有结束 ≤ 1 y；到期删除；缺结束发脚本卡 | 续期提醒、保留 |
| 004 | ~~只在绝对时刻触发；无宽限/补跑~~ **已被 ADR-013 取代（2026-10-17）** | grace window 120 min |
| 005 | reminder / agent 任务两类；reminder 先上线 | 只有 agent |
| 006 | 每 fire 独立、暂无硬并发上限。~~允许重叠~~ 中「同一 agent 任务允许叠跑」**已被 ADR-021 取代（2026-10-18）**；reminder 与不同任务仍互不阻塞 | 运行中则跳过、子池上限 |
| 007 | 置顶看板带暂停/删除，任何人可点；重新置顶；列表命令兜底 | D3 仅创建者、D6 只读看板 |
| 008 | monitor hook = 看板内可见机读块（note 元素）；本地 status 文件为事实源；字段见 ADR-015 | — |
| 009 | 暂无每群硬限额 | 10 / 5 |
| 010 | v1 不做原地编辑：删除后重建（**用户确认 2026-10-16**） | `/auto edit` |
| 011 | 每次 fire 自起 session，无并发上限，永不 `pool-full` 失败（**用户确认 2026-10-16**） | 子池/主池 tryAcquire |
| 012 | bot 被移出群或群解散 → 删除该群任务（**用户确认 2026-10-16**） | — |
| 013 | 无固定宽限；miss rule = 未暂停且 `now > nextFireAt` 且 `lastFireAt < nextFireAt`。miss 后 ≤ 24 h 补跑恰好一次（fire key = `id` + 计划 `nextFireAt` 幂等），消息注明原定时间；> 24 h 只标 missed。Larkent 重启 / link 恢复时自身执行同一规则；Larkent 先自行补跑时，monitor 后续唤醒静默（**用户确认 2026-10-17**） | ADR-004 |
| 014 | larkent-monitor 私有，只服务常驻 Grok Bot box（其他 PC 不在范围）；只读置顶看板卡 status block；Cloudflare Worker 扫描 → wake webhook 唤醒 box，无 GitHub Action；每个 fire key 至多唤醒一次；被唤醒侧按 fire key 检查，已执行则静默、不向任何人报告（**用户确认 2026-10-17**） | Out of Scope 中“monitor 预唤醒” |
| 015 | status block v1 增加每项 `id`（每 profile 自增短编号，同 `/auto` 编号，永不复用，绝非飞书 ID）、每项 `paused`、卡片级 `updatedAt`；时间均为 UTC 毫秒；沿用 note 元素通道（**用户确认 2026-10-17**） | ADR-008 原字段集 |
| 016 | 多个错过时刻只补 24 h 内最近一个；其余每个“已错过”必须留痕：看板逐条（含原定时间）+ 群内通知 + 本地日志（**用户确认 2026-10-17**） | Open question 1 |
| 017 | one-shot 未补跑：`nextFireAt = 0`、看板“已错过”、24 h 后按到期删除；本地日志永久保留错过记录（**用户确认 2026-10-17**） | Open question 2 |
| 018 | 超出 1 h uuid 窗口的重复投递为理论风险，不开 ticket、不处理（**用户确认 2026-10-17**） | Open question 3 |
| 019 | agent 任务补跑上限保持 24 h；补跑 result post 注明“补跑，原定 HH:MM”，另写本地 catch-up 日志（**用户确认 2026-10-17**） | Open question 4 |
| 020 | 任务类型改名 agent 任务（agent task），开关 `automations.agentTasks` 默认关（**用户确认 2026-10-17**） | “agent kind”、`automations.agentKind` |
| 021 | 定时器每段 ≤ 60 秒，醒来按墙钟重算（取代单段约 24 天的 arm）。准点宽限 60 秒只决定是否标「补跑」：晚于 `nextFireAt` 不超过 60 秒且没有更早的漏跑则不标；miss rule 与 24 小时补跑上限不变。同一 agent 任务上一次未结束则跳过本次：看板“已跳过”+ 本地日志（原定时间与原因），不发群消息、不并发、不排队，`lastStatus` 不覆盖。started fire key 保留 48 小时（**用户确认 2026-10-18**） | ADR-006 的 agent 任务叠跑；长延迟单段 arm |
