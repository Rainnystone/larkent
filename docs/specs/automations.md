# Spec: In-group automations（群内定时自动化）

Status: ready-for-agent · Docs track: PR #44（本分支）· Code track: separate PR, one ticket per session
Tickets: [`automations/tickets/`](automations/tickets/README.md)
Baseline: `master@426f670`（run-reliability 已合入）。**Depends on link-recovery（PR #47）只到契约层**：fire 结果的投递复用其 **Outbox**（stage → send → delivered → recovery 时 redeliver），link down / recovered 信号来自其 **FeishuLink**；**永不**使用 **Continuations**（fire 被中断不提供“继续”，也不自动续跑）。时间表、存储、scheduler、补跑规则与创建流程不依赖 #47，可先做；每张 ticket 标注 `Depends on #47: none | soft | hard`。
Decisions: grill 2026-10-16 锁定 ADR-001..012；grill 2026-10-17 新增 ADR-013..015（补跑规则、larkent-monitor 路线、status block v1），ADR-013 **取代** ADR-004。见文末 Decision log。本文只写行为、决策、边界与验收，不写文件路径。

---

## Problem Statement

群成员想让 bot 在某个时刻或按周期做事：到点提醒一句话，或到点跑一次 agent 并把结果发回群里。现在只能每次手动 @bot。约束：

- 群里的人工对话不能被打扰、排队或混入自动化内容。
- agent 默认 full 权限、自动批准工具；profile 的 lark-cli 同时持有 bot 与 owner 用户身份（含加/减群成员）。自动化把它变成“无人值守、延迟、重复”的能力。
- 飞书卡片只能由发送身份更新；多个 bot 共处一群；飞书**没有**置顶/取消置顶事件（实测，见 Further Notes）。
- 承载 bridge 的进程会停（崩溃、重启、主机睡眠）或 link 断开，到点的 fire 会错过。Larkent 自己在重启 / link 恢复时按同一规则补跑；私有的 larkent-monitor（只服务常驻的 Grok Bot box）读取看板里的机读 status block，发现 miss 后唤醒 box。两条路径都按 fire key 幂等，同一 fire 只执行一次。

## Solution

- 群里 @bot，用自然语言或 `/auto new` 创建 **automation**：**一次性**或**周期**（iPhone 日历模型），类型为 **reminder**（纯文本，无成本）或 **agent**（跑一次 agent prompt）。
- bridge 校验时间表；缺结束时间时发**确定性脚本卡**索要；齐全后发**确认卡**（逐字列出类型、时间表、时区、接下来 3 次触发、结束时间、任务原文、执行身份），群里任何人点「是」即生效。
- 到点：reminder 发一条文本；agent 在后台新开 session 跑一次，结果发为一条 **result post**，可在其话题里追问。每次 fire 互不阻塞，允许重叠。
- 每个有自动化的 bot 在群里置顶一张自己的 **board**：每任务一行（内容、下次触发、结束），带【暂停】【删除】按钮，任何人可点；卡内含可见的机读 **monitor hook** 文本块。被取消置顶会在下次看板更新时重新置顶。
- `/auto` 列表命令作为备用查看入口。
- 周期任务到期即删除，无续期提醒、无保留。
- 错过的 fire（计划时刻已过、未执行、未暂停）在 **24 小时内**补跑**恰好一次**（按 fire key 幂等），消息注明原定时间（如“原定 12:30”）；超过 24 小时的不补跑，看板标为错过。

## User Stories

1. As a group member, I want to say “10 分钟后提醒我交周报”, so that I get a one-shot reminder without learning syntax.
2. As a group member, I want relative input converted to an absolute time and shown on the confirm card, so that I know exactly when it fires.
3. As a group member, I want “每个工作日 9:00 提醒站会，到年底结束”, so that routine reminders run themselves.
4. As a group member, I want weekly schedules on chosen weekdays at one or more times, so that I can match my team rhythm.
5. As a group member, I want “每 30 分钟，9:00–18:00” style schedules, so that I can poll something during work hours.
6. As a group member, I want a window that crosses midnight (22:00–02:00), so that night shifts are covered.
7. As a group member, I want an agent task (“工作日 9 点汇总昨天的 issue”), so that the bot does real work on schedule.
8. As a group member, I want the confirm card to say whether it is a reminder or an agent run, so that I know whether it costs anything.
9. As a group member, I want a scripted card asking for an end date when I forget one, so that recurring tasks never run forever.
10. As a group member, I want recurring tasks capped at one year and one-shots at one year ahead, so that forgotten tasks die.
11. As a group member, I want too-frequent schedules rejected (reminder < 10 min, agent < 1 h) with a clear message, so that the group isn't spammed.
12. As any group member, I want to confirm a draft with one tap, so that creation is quick.
13. As a group member, I want each agent fire to start a fresh session, so that runs don't leak into each other.
14. As a group member, I want a fire never to wait for or be skipped because of the previous fire, so that the schedule is honoured.
15. As a group member, I want automation runs never to block or merge with human chat, so that conversation stays responsive.
16. As a group member, I want exactly one result post per agent fire and to follow up in its thread, so that results are tidy.
17. As a group member, I want a pinned board listing this bot's tasks with next fire and end, so that I can see what will happen.
18. As any group member, I want Pause and Delete buttons on the board, so that anyone can stop a noisy task.
19. As a group member, I want the board re-pinned if someone unpins it, so that it stays findable without deleting tasks.
20. As a group member, I want `/auto` to list tasks when the board is out of sight, so that there is a fallback.
21. As a group member, I want weekday schedules to state they ignore holiday swaps, so that I'm not surprised on 调休 days.
22. As a group member, I want times to follow the profile timezone with sane DST handling, so that 9:00 stays 9:00.
23. As a group member, I want an expired recurring task to disappear, so that the board stays clean.
24. As a group member, I want a fire missed while the bridge was down to be caught up once within 24 h with “原定 HH:mm” noted, and anything older only marked missed, so that I still get recent reminders but never stale ones.
25. As an operator, I want a restart, a link recovery and a monitor wake to never fire the same fire key twice, whichever comes first, so that duplicates don't happen.
26. As an operator, I want fire results delivered through the link-recovery outbox, so that a failed send is redelivered after recovery.
27. As an operator, I want automation runs blocked from personnel/org operations by a bridge whitelist, so that an unattended run can't add or remove members.
28. As an operator, I want a machine-readable status block in the board card (per-item short `id`, `paused`, card-level `updatedAt`), so that larkent-monitor can detect a miss and wake the always-on box after it.
29. As an operator, I want that block to contain no Feishu IDs, task content or creator, so that nothing sensitive leaks.
30. As an operator, I want structured log events for create/confirm/fire/missed/result/policy-guard, so that I can audit behaviour.
31. As an operator, I want the feature off by default per profile, so that rollout is controlled.
32. As an operator, I want reminder kind to ship before agent kind, so that the zero-cost path proves the scheduler first.
33. As a maintainer, I want schedule parsing and next-fire computation as pure functions with an injected clock, so that they are table-testable.
34. As a maintainer, I want an E2E in Bot Arena using a fake clock or test-only floor override, so that tests respect the 10-minute floor in production.
35. As a group member, I want removing the bot from the group to stop its tasks there, so that nothing fires into a chat the bot left.
36. As an operator, I want a woken box that finds the fire already ran to stay silent and report to nobody, so that a monitor wake never produces noise.

## Implementation Decisions

### 1. Glossary（同步并入 CONTEXT.md，随代码 PR 合并，避免与 link-recovery 冲突）

- **automation**：绑定一个群和一个 bot profile 的持久任务；`kind` 为 reminder 或 agent。
- **one-shot**：单个绝对 UTC 时刻，最远 1 年后。
- **recurring**：规则 + IANA 时区 + 起止 UTC 时刻；必须有结束，最长 1 年。
- **reminder**：到点发纯文本，不跑 agent；最小提前量/间隔 10 分钟。
- **agent task**：到点跑一次 agent prompt；最小间隔 1 小时。
- **fire**：时间表上的一个绝对时刻。
- **automation id**：每 profile 自增的短编号，与 `/auto` 列表编号相同；**永不复用**（删除后编号不回收），不是飞书 ID。
- **fire key**：`id` + 计划时刻 `nextFireAt`（UTC 毫秒），如 `3@1792218600000`；跨重启、link 恢复与 monitor 唤醒幂等。
- **started**：fire key 已在执行前持久化；从此该 fire 视为“已执行”，后续投递失败交给 Outbox，不再按补跑处理。
- **automation run**：没有触发消息、scope 为 `auto:<id>:<fireAt>` 的 run。CONTEXT 中 **run** 放宽为“一条飞书消息或一次 fire”。
- **result post**：一次 agent fire 的唯一权威消息；**bridge-owned final reply** 扩展到 fire；经 Outbox 投递。
- **follow-up thread**：以 result post 为根的话题，续接该 fire 的 session。
- **miss rule**（无固定宽限）：一项任务 missed 当且仅当 `!paused && nextFireAt > 0 && now > nextFireAt && lastFireAt < nextFireAt`。monitor 与 Larkent 使用同一条规则。
- **catch-up**（补跑）：对 missed 的 fire，在计划时刻后 24 小时内执行恰好一次（按 fire key 幂等），消息注明原定时间；超过 24 小时只记 `missed`（计数 +1，看板标出），不执行。
- **missed**（计数）：最终未执行的 fire 数；补跑成功的不计入。
- **expire**：周期任务过结束时刻后删除。
- **scripted card**：bridge 确定性渲染的固定卡片（缺结束时间、校验失败），不经 agent。
- **draft**：等待确认的自动化，TTL 24 小时。
- **board**：每 bot 每群一张置顶卡；行 + 暂停/删除按钮。
- **monitor hook** / **status block**：board 内可见的机读文本块（note 元素）；事实源为本地 status 文件。
- **larkent-monitor**：私有的外部监视器，只服务常驻的 Grok Bot box；路线为 Cloudflare Worker 扫描看板 → wake webhook 唤醒 box；不涉及 GitHub Action。其实现不在本仓库。
- **scheduler**：按 `nextFireAt` 产生 fire 的定时器，归 profile 所有；启动、link 恢复与本机唤醒入口触发时执行同一补跑规则；与 backfill 无关。
- **automation creator**（`createdBy`）：促成创建那条消息的人；**bot owner** 即现 `isCreator()`，改名 `isBotOwner()`。

### 2. Time model（ADR-001/002/003）

- 相对时间只是输入；落库为绝对时间。one-shot 存 UTC 时刻；recurring 存规则 + IANA 时区 + `startAt` / `endAt`（UTC），并持久化 `nextFireAt`、`lastFireAt`。
- `lastFireAt` 记录**最后一次 started 的计划时刻**（不是实际执行时刻）；补跑 12:30 的 fire 后 `lastFireAt` = 12:30。`nextFireAt` 在该 fire started 或被判定为超 24 小时放弃之前**不推进**，因此停机期间看板上的 `nextFireAt` 就是被错过的时刻。无后续触发时 `nextFireAt = 0`。
- 规则：
  - `daily` 若干时刻；`weekday`（周一至周五，v1 不计调休，卡片明示）；`weekly`（选定星期 + 若干时刻）。
  - `every N minutes|hours`，N 分钟 ≥ 10；可选时间窗 `[from, to)`，允许跨午夜（归属开始日）。
  - 无每日次数上限。
- 下限：reminder 最小提前量与间隔 10 分钟；agent 最小间隔 1 小时（多时刻规则按相邻时刻差校验）。one-shot ≤ 1 年后；recurring `endAt − startAt ≤ 1 年`。
- 时区：profile 默认 IANA，再默认 `Asia/Shanghai`；不依赖主机时区。DST：不存在的本地时刻顺延到下一个有效分钟；重复的本地时刻只取第一次。
- 缺 `endAt` 的 recurring：bridge 发 scripted card 索要（按钮给常用选项 + 文本输入），收到前不出确认卡。
- 到期：最后一次 fire 后或过 `endAt` 即删除，看板移除该行；无续期提醒、无保留。

### 3. Creation and confirmation

- 任何能 @bot 且通过该群 access 的**人**可创建；bot 消息与 automation run 产生的提案一律忽略（防自我复制）。
- 自然语言：agent 产出结构化提案（含 kind、时间表、任务文本）；群、scope、创建者取自当前 run 上下文。bridge 校验后建 draft，发确认卡；内容与落库逐字一致。
- `/auto new <时间表> | <名称> | <任务>` 走同一张卡；`|` 只切前两个；kind 默认 reminder，`/auto new agent ...` 指定 agent。
- 确认卡按钮使用**新签名 action**：绑定 draft、群、动作、一次性 nonce、TTL；不绑 operator、不要求运行中 run；授权 = 回调点击者为人 + 通过该群 access；只接受 bridge 登记过的卡片。与 run-reliability 的 notice action 共用签名基础。
- 编辑：v1 不提供原地编辑；删除后重建。

### 4. Scheduler, fire and catch-up（ADR-006/013）

- scheduler 归 profile，跨 `/reconnect`、bridge swap、进程重启存活。
- 正常路径：到达 `nextFireAt` 时开始该 fire。
- **幂等**：开始执行前先原子持久化 fire key 为 started（并写 `lastFireAt`），然后才发送或启动 agent；同一 fire key 不再执行。started 之后的投递失败只走 Outbox redeliver，不按补跑重来。
- **补跑规则（Larkent 自身执行，不依赖 monitor，也不留给实现者自行决定）**，在以下时机运行，规则完全相同：
  1. 进程启动 / 重启；
  2. FeishuLink 由 down 恢复（`link.recovered`）；
  3. 本机唤醒入口（见 §7，供 monitor 唤醒的 box 使用）。

  对每个按 miss rule 判定 missed 的任务：
  - 若计划时刻距 `now` ≤ 24 小时：执行**恰好一次**补跑（fire key = `id` + 被错过的计划时刻），reminder 文本与 agent result post 都注明“原定 HH:mm”（按任务时区）；agent 的提示词附一行迟到说明。
  - 若 > 24 小时：不执行；`missed` +1，`lastStatus = missed`，看板标出；推进到下一时刻。
  - 同一任务若错过多个计划时刻，只补跑 24 小时内**最近**的一个，其余计入 `missed`（防止停机数小时后连发；见 Open questions）。
  - 补跑后 `nextFireAt` 从 `now` 重算到下一个未来时刻；若已无后续（one-shot 或过 `endAt`），按 §2 到期删除。
  - paused 的任务不补跑；恢复后从 `now` 重算，不补暂停期间的 fire。删除的任务永不补跑。
- **任一路径先到都安全**：Larkent 自己重启并补跑后，monitor 再唤醒 box，box 按 fire key 查到已 started → 静默，不对任何人报告；反之亦然。并发到达时以 fire key 的持久化为准，只有一个执行。
- **link down 时到点**：不开始该 fire（不 stage、不计 started），该 fire 保持 missed 状态；link 恢复时按上述补跑规则处理（≤ 24 小时补跑一次并注明原定时间）。
- 每次 fire 独立：新 session、scope `auto:<id>:<fireAt>`；不等待、不因同任务上一次未结束而跳过（允许重叠）；不进入群 pending queue，不与人工消息合并。
- 并发：每次 fire 立即启动自己的 session，**不经过 profile 进程池、不设并发上限、永不因池满失败或排队**（以后可收紧）；人工 run 也不会排在自动化之后。
- 每次 fire 前校验：bot 仍在群内；否则见 §8。

### 5. Kinds（ADR-005）

- **reminder**：发一条文本消息“⏰ 名称：任务文本”（补跑时追加“（原定 HH:mm）”）；无 agent、无成本。经 Outbox 投递，投递键由 fire key 派生。先上线。
- 投递去重：Outbox 的 Feishu uuid 去重只覆盖 1 小时；fire 是顶层消息（无 parent），不能靠按 parent 回读去重。超过 1 小时的去重以本地 fire key 的 started / delivered 记录为准（见 Open questions）。
- **agent**：在创建时快照的 cwd 下、用该 profile 自己的 agent 跑任务文本；结果作为 result post 一次性发出（无 Typing、无流式卡、无 CoT）；页脚提示“在本消息话题里追问”。硬超时与 link-recovery 的默认空闲上界一致。
- agent 已自行发到本群：沿用 `skip-cli-already-sent`，fire 记 delivered-by-agent。
- 追问：result post 话题里的回复续接该 fire 的 session（普通群需按根消息匹配，因普通群回复不带 thread_id）。

### 6. Safety for agent kind

- 优先仅 bot 身份（独立 lark-cli 身份配置，无用户授权），系统提示词使用自动化变体。
- bridge 层 **tool whitelist**：人事/组织能力（建群、成员增删、退群、群设置、通讯录、人事）或请求用户身份 → 立即停止，`StopRequest` 新增 `policy-guard`，outcome `interrupted(policy-guard)`，群内通知，自动化暂停。审计日志脱敏。
- 诚实边界：agent 有完整 shell，这是纵深防御；确认卡如实说明。**whitelist 与仅 bot 身份验证前，agent kind 不得在线上开启**；reminder 不受此限。

### 7. Board（ADR-007）与 monitor hook（ADR-008）

- 每 bot 每群一张卡，只含本 bot 的任务；同数据根内锁 + 租约保证单写者；去抖更新。
- 行：名称/内容摘要、kind、下次触发、结束时间、状态；按钮【暂停/恢复】【删除】，**群里任何人可点**（暂无权限校验；被滥用再议）。点击后卡片原地更新。
- 置顶：无 unpin 事件，每次更新看板时查询本群 pins，若本卡不在则重新置顶；pin 失败提示一次。取消置顶不影响任务。本 bot 在群内无任务时卡片显示“暂无”并取消置顶。
- 卡片无法更新（丢失/过期）时重发并置顶，尝试取消旧卡置顶。
- **monitor hook / status block**（ADR-008、ADR-015；沿用现有 note 元素通道）：卡内一个**可见**文本块（note 元素；HTML 注释与按钮 value 对读者不可见），一行 JSON，`v` 仍为 1：

```json
{"v":1,"bot":"<display name>","updatedAt":0,"items":[{"id":3,"paused":false,"nextFireAt":0,"lastFireAt":0,"lastStatus":"ok|missed|failed|running","endAt":0,"missed":0}]}
```
  - 时间均为 UTC 毫秒。`id` 是 §1 的短编号（与 `/auto` 编号相同），**永远不是飞书 ID**。`updatedAt` 为卡片级，每次渲染写入。`nextFireAt = 0` 表示无后续触发。
  - 不含飞书 ID、任务内容、创建者。事实源为 profile 数据目录下的本地 status 文件（随 scheduler 原子写），卡片由其渲染。
- **larkent-monitor 契约**（monitor 私有，只服务常驻的 Grok Bot box；其他 PC 不在范围内）：
  - 只从置顶看板卡的 status block 读状态；路线为 Cloudflare Worker 扫描 → wake webhook 唤醒 box；不涉及 GitHub Action。
  - 按 §1 的 miss rule 判定；对每个 fire key（`id` + 当时的 `nextFireAt`）**至多唤醒一次**。
  - monitor 在 miss **之后**唤醒，不做预唤醒。
- **本机唤醒入口**（Larkent 暴露，被唤醒的 box 调用）：给定 fire key，若该 fire 已 started → 无输出、不发任何消息、不向任何人报告；否则（Larkent 未运行则先启动）按 §4 补跑规则处理，补跑恰好一次，> 24 小时只标 missed。该入口幂等，可重复调用。
- `/auto`：列出本群本 bot 的任务（任何人）；`/auto pause|resume|delete <编号>` 与按钮等价。

### 8. Lifecycle edges

- bot 被移出群或群解散（发送报“不在群内”或成员事件）：该群任务删除，看板不再写；日志一条。
- 私聊：不支持（回复“仅支持群”）。
- 无每群 / 每人硬限额（ADR-009）；确认卡写出“约每月 N 次”。

### 9. Storage and rollout

- 每 profile 一个 automations 文件，`schemaVersion: 1`，原子写，supervisor 持有（与 turn journal 同级）；未来版本拒绝加载且不覆盖；旧代码忽略。fire 历史只保留每任务最近若干条。
- `automations.enabled`（profile 级，默认关）；`automations.agentKind` 单独开关（默认关）。

### 10. Observability

结构化事件：`auto.draft`、`auto.confirmed`、`auto.rejected`、`auto.fire`、`auto.missed`、`auto.catch-up`（含原定时刻与触发来源：startup / link-recovered / wake）、`auto.wake.already-started`（静默，仅本地日志）、`auto.result`（outcome）、`auto.paused`、`auto.deleted`、`auto.expired`、`auto.policy-guard`、`auto.board.repin`。不含任务正文。

### 11. Backfill fix (F20)

backfill 从 scope 推导 chat id 时，`auto:` 与 `meeting:` scope 永不进入 chat mode 查询。

## Testing Decisions

- 只测外部行为：群里看到什么（消息、卡片状态、置顶）、落库与 hook 文本。用 recording channel、scripted CLI、fake executable、fake clock。
- 最高测试缝：channel 级“推进时钟 → 群里可见输出 + 日志/状态文件”；与 run outcome / turn journal 集成测试同层。时间表解析与下次触发为纯函数，注入 `now()`，在 UTC 宿主时区跑表驱动用例（DST、跨午夜窗口、下限、1 年上限）。
- 真飞书层：`e2e/test-bridge/`（默认 fake CLI，硬围栏）在 Bot Arena 跑；使用 fake clock 或**仅测试可用**的下限覆盖，不使用“1 分钟后”的生产输入。证据脱敏，不含任何 ID。
- 补跑与幂等：fake clock 表驱动覆盖 miss rule 边界（`now == nextFireAt` 不算 miss、paused 不算、`lastFireAt == nextFireAt` 不算）、24 小时边界、多个错过时刻只补最近一个、重启 / link 恢复 / 唤醒入口任意顺序与并发到达都只执行一次。
- 不设延迟/耗时类验收。

## Out of Scope

p2p 自动化；命令型自动化；节假日调休日历；原地编辑；固定宽限窗口（grace）；超过 24 小时的补跑；续期提醒；硬并发与每群限额（可后续收紧）；跨群创建；fire 之间携带上次结果；跨 bot 共享看板 / 多维表格台账；附件/图片任务；larkent-monitor 本身的实现（私有，不在本仓库）；monitor 服务常驻 Grok Bot box 以外的电脑；monitor 预唤醒（monitor 只在 miss 之后唤醒，见 ADR-014）。

## Further Notes

- Bot Arena 实测（2026-10-16）：bot 可发交互卡、im/v1/pins 置顶与取消、PATCH 原地更新（需 `update_multi`）；只读第三方应用可列 pins 并读卡片，但读到的是简化渲染——HTML 注释与按钮 value 丢失，note 文本完整；pin/unpin 不产生事件或系统消息；按钮回调未验证（需运行 test bridge + 真人点击）。
- 待验证：回调点击者身份可靠性；话题群中 result post / 追问行为；线上 bot 实际 scope 与仅 bot 身份可行性；多 profile 是否共用数据根。

### Open questions（2026-10-17，实现前需用户确认；Spec 先按括号内默认写）

1. 同一任务停机期间错过多个计划时刻：只补跑 24 小时内最近一个、其余计 missed（默认），还是每个都补？
2. one-shot 超过 24 小时未补跑：看板该行显示“已错过”后何时删除（默认：`nextFireAt = 0`、显示已错过，24 小时后按到期删除）？
3. 超出 Outbox 1 小时 uuid 窗口的 fire 投递（顶层消息无 parent 可回读）：发出但回执丢失时理论上可能重复一次；是否接受，或要求按 bot 发送记录回读？
4. agent kind 补跑最晚可迟 24 小时：是否要更短的上限（例如 agent 只补 1 小时内）？

### Decision log（2026-10-16 grill）

| ADR | 决定 | 取代 |
|---|---|---|
| 001 | iPhone 日历模型；存绝对时间 | 只存 IANA |
| 002 | 规则集与下限（reminder 10 min、agent 1 h、one-shot ≤ 1 y）；工作日不计调休 | 每天 ≤ 4 时刻、无每 N 分钟 |
| 003 | recurring 必须有结束 ≤ 1 y；到期删除；缺结束发脚本卡 | 续期提醒、保留 |
| 004 | ~~只在绝对时刻触发；无宽限/补跑~~ **已被 ADR-013 取代（2026-10-17）** | grace window 120 min |
| 005 | reminder / agent 两类；reminder 先上线 | 只有 agent |
| 006 | 每 fire 独立、允许重叠、暂无硬并发上限 | 运行中则跳过、子池上限 |
| 007 | 置顶看板带暂停/删除，任何人可点；重新置顶；列表命令兜底 | D3 仅创建者、D6 只读看板 |
| 008 | monitor hook = 看板内可见机读块（note 元素）；本地 status 文件为事实源；字段见 ADR-015 | — |
| 009 | 暂无每群硬限额 | 10 / 5 |
| 010 | v1 不做原地编辑：删除后重建（**用户确认 2026-10-16**） | `/auto edit` |
| 011 | 每次 fire 自起 session，无并发上限，永不 `pool-full` 失败（**用户确认 2026-10-16**） | 子池/主池 tryAcquire |
| 012 | bot 被移出群或群解散 → 删除该群任务（**用户确认 2026-10-16**） | — |
| 013 | 无固定宽限；miss rule = 未暂停且 `now > nextFireAt` 且 `lastFireAt < nextFireAt`。miss 后 ≤ 24 h 补跑恰好一次（fire key = `id` + 计划 `nextFireAt` 幂等），消息注明原定时间；> 24 h 只标 missed。Larkent 重启 / link 恢复时自身执行同一规则；Larkent 先自行补跑时，monitor 后续唤醒静默（**用户确认 2026-10-17**） | ADR-004 |
| 014 | larkent-monitor 私有，只服务常驻 Grok Bot box（其他 PC 不在范围）；只读置顶看板卡 status block；Cloudflare Worker 扫描 → wake webhook 唤醒 box，无 GitHub Action；每个 fire key 至多唤醒一次；被唤醒侧按 fire key 检查，已执行则静默、不向任何人报告（**用户确认 2026-10-17**） | Out of Scope 中“monitor 预唤醒” |
| 015 | status block v1 增加每项 `id`（每 profile 自增短编号，同 `/auto` 编号，永不复用，绝非飞书 ID）、每项 `paused`、卡片级 `updatedAt`；时间均为 UTC 毫秒；沿用 note 元素通道（**用户确认 2026-10-17**） | ADR-008 原字段集 |
