# Spec: In-group automations（群内定时自动化）

Status: ready-for-agent（docs track）。Grill 已完成（设计记录见 PR #43）；第 4 节的产品决策已由用户锁定，不再重新 Grill。第 10 节的阻断项需要 test bridge 或开发者控制台验证后才能拆对应 ticket。
Written 2026-10-16，基线 `feat/run-reliability@43f4050`（run-reliability 的 mini-baseline，不是 master）。本 spec 引用该分支上已有的 `RunOutcome` / `StopRequest`、turn journal、scope 规则、硬 access 围栏和 `e2e/test-bridge/`。

本文是目的地，只写行为、产品决策、边界和验收；不写 ticket，不写文件级构造。

---

## 1. Problem Statement

群成员希望让 bot 定时做事（例如“工作日 9:00 汇总昨天的 issue”），到点后在后台跑一次 agent，把结果发回群里。现在只能每次手动 @bot。

约束来自现状：
- 群里的人工对话不能被打扰：不能排队在自动化后面、不能被合并进同一批、不能被写入自动化内容。
- agent 默认 `full` 权限、自动批准工具调用；profile 的 lark-cli 身份同时持有 bot 和 bot owner 的用户身份，而用户身份带有加/减群成员的权限。team 模式下任何群成员都能 @bot。自动化把这种能力变成“无人值守、延迟、重复”的。
- 飞书卡片只能由发送它的身份更新（probe：其他身份更新返回 230001），而多个 bot 共处一群。

## 2. Solution（用户视角）

- 群里任何人 @bot，用自然语言（“每个工作日 9 点帮我…”）或 `/auto new 时间表 | 名称 | 任务` 创建自动化。bot 回复一段确定性渲染的完整描述和一张「是 / 否」卡，群里任何人都能点。
- 到点后 bot 在后台独立跑一次，群里只出现一条结果消息；想追问就在这条结果消息的话题里回复。
- 群里有一张置顶看板卡，列出本群所有（同数据根）bot 的自动化及下次执行时间、最近状态。
- 只有创建者能编辑、暂停、删除自己的自动化。
- 自动化**不能**做任何人事/组织操作（建群、加人、踢人、退群等）。

## 3. Vocabulary（同步加入 CONTEXT.md）

- **automation**：持久记录，绑定一个群和一个 profile；含时间表、时区、名称、任务文本、cwd 快照、创建者、确认人、状态。
- **automation creator**（`createdBy`）：发出促成创建那条消息的**人**。不要裸用 “creator”。
- **bot owner**：飞书应用所有者。现有 `isCreator()` 指的就是 bot owner，重命名为 `isBotOwner()`（行为不变）。
- **confirmer**：在确认卡上点「是」的人，可以是任何群成员。
- **draft**：等待「是/否」的自动化，带 TTL。
- **fire**：时间表上的一个时刻；一次 fire 至多一次 automation run。
- **automation run**：没有触发消息的 run，scope 为 `auto:<automationId>`。CONTEXT.md 中 **run** 的定义放宽为“一条飞书消息或一次 fire”。
- **result post**：bridge 为一次 fire 发到群里的唯一一条权威消息；**bridge-owned final reply** 的定义扩展到 fire。
- **follow-up thread**：以 result post 为根的话题，续接该 fire 的 session。
- **scheduler**：按时间表产生 fire 的定时器，归 profile 所有。它不是恢复机制，与 backfill 无关。
- **grace window**：错过 fire 后仍允许补跑的时长；不同于 backfill window。
- **automation sub-pool**：profile 内专供自动化 run 的并发槽。
- **board / board holder**：每群一张置顶看板卡 / 唯一负责写这张卡的 bot。
- **automation tool whitelist**：自动化 run 中允许的 bridge/lark-cli 能力白名单。

## 4. Locked decisions

D1. **创建**：群里任何能 @bot 并通过该群 access（含 run-reliability 0a 围栏，若启用）的**人**都可以创建。bot 发出的消息、以及自动化 run 自身都不能创建自动化（防自我复制）。
D2. **无人事/组织能力**：自动化 run 不得建群、加/减成员、退群/入群、改群设置或群管理员、读写通讯录或人事数据。因为 profile 的用户身份确实有加/减成员权限，**必须**在 bridge 层对自动化 run 施加 tool whitelist 强制阻断，不能只靠提示词（见 §5.6）。
D3. **编辑权**：只有 automation creator 能编辑、暂停、恢复、删除、立即执行；bot owner、profile admin、其他成员都不能（bot owner 本人是创建者时除外）。代码中凡指“bot owner”的 `isCreator` 一律改名 `isBotOwner`。
D4. **自然语言确认**：自然语言创建必须先出描述 + 「是 / 否」卡，群里任何被允许的人都可以点。`/auto new` 走同一张卡（入口一致）。
D5. **时间与语法**：工作日 = 周一到周五（不含节假日调休）；`/auto` 用 `|` 分隔，只按前两个 `|` 切分。
D6. **看板**：每群一张置顶看板卡，覆盖所有 bot（受 §5.8 与 §10 的单写者限制）。
D7. **范围**：不支持 p2p 自动化；不支持命令型自动化（任务文本永远不经过斜杠命令处理）。
D8. **运行形态**：后台运行，不影响进行中的对话；每次 fire 一个全新 session；scope `auto:<id>`，与人工 run 并行，占用自动化子池；结果一次性发出，无 Typing 表情、无流式卡、无 CoT；追问在 result post 的话题里；cwd 在创建时快照；优先使用仅 bot 身份。
D9. **看板单写者**：同一数据根内，以文件锁 + 租约选出唯一 board holder。
D10. **修 F20**：backfill 不得把 `auto:` 与 `meeting:` scope 送进 chat mode 查询（见 §5.10）。

## 5. Behavior

### 5.1 创建与确认
- 自然语言：agent 产生一个结构化提案（协议由实现者定，bridge 侧校验）；bridge 生成 draft（TTL 24 小时），随后发：①agent 回复（去掉提案）+ **bridge 确定性渲染**的描述：名称、时间表、时区、接下来 3 次执行时间、目标群、创建者、执行身份、cwd、补跑宽限、超时、谁能编辑、任务原文、“禁止人事/组织操作”声明、同 cwd 并发写风险提示；②「是 / 否」卡。用户确认的内容与落库内容逐字一致。
- 提案中出现的群、scope、创建者一律忽略，取自当前 run 上下文。批次多发送者时创建者 = 最后一条人类消息的发送者（与 run-reliability 的 initiator 定义一致）。
- 「是」：转为正式自动化，记录 `confirmedBy`；卡片更新为“已由 X 确认”；更新看板。「否」：draft 作废。过期/重复点击：无副作用，提示已失效。
- 确认按钮需要**新的签名 action 类型**：绑定 draft、群、动作、一次性 nonce、过期时间；**不绑定 operator、不要求有运行中的 run**。授权依据是飞书回调里的点击者 + 该群 access + 点击者是人。只接受 bridge 自己登记过的卡片消息（CLI 自发的卡无效）。这与 run-reliability D8 的“不绑运行中 run 的签名 action”共用基础。
- 自然语言的编辑/删除提案同样出卡，但只有创建者点「是」有效。

### 5.2 `/auto` 命令
```
/auto                                       列出本群中本 bot 的自动化（任何人）
/auto new <时间表> | <名称> | <任务>          创建（进入确认卡）
/auto show <编号>
/auto edit <编号> <时间表> | <名称> | <任务>   某段写 - 表示不改（仅创建者）
/auto pause|resume|delete|run|stop <编号>    仅创建者
```
- 时间表：`每天 HH:MM`、`工作日 HH:MM`、`每周一三五 HH:MM`、`一次 YYYY-MM-DD HH:MM`；多个时刻逗号分隔，每天最多 4 个。v1 不支持“每 N 分钟”。
- 时区存 IANA 名，默认 profile 偏好，再默认 `Asia/Shanghai`；不依赖主机时区。
- 需要 @ 的群里 `/auto` 也要 @bot；p2p 中回复“仅支持群”。`/auto` 不是 admin 命令，创建者校验在命令内部。
- 管理员现有 `/stop auto:<id>` 保留为安全阀（停止 ≠ 编辑）。

### 5.3 调度
- 调度器归 profile 所有，跨 `/reconnect` 和 keepalive restart 存活，不重复触发、不丢状态。
- 同一自动化同一时刻至多一个 fire；上一次未结束时本次记为“跳过：仍在运行”。
- 同分钟的 fire 加确定性抖动（0–60 秒），显示仍用计划时间。
- 断线/重连期间（`reconnect-in-progress`）不算失败，恢复后在宽限内重试。
- 补跑：宽限默认 120 分钟（0–720 可设）；多次错过只补最近一次；下一次正常 fire 早于宽限截止则不补；补跑注入延迟提示，结果页脚标注延迟；超出宽限只在看板显示“错过”。
- 每次 fire 重新核验：创建者仍通过该群 access、仍在群内；否则暂停（见 §10 孤儿问题）。

### 5.4 运行隔离
- scope `auto:<id>`；`ActiveRuns`、pending queue、session、`/stop`、`/new` 与群 scope 天然隔离。群里的 `/stop`、`/new`、`/cd` 不影响自动化；自动化不进入 pending queue，不与人工消息合并。
- 每次 fire 前清空该 scope 的 session，不续接上次，也不注入群 session 历史。
- cwd 用创建时快照，fire 时校验仍有效；群 `/cd` 不改变已有自动化。
- 并发：先拿自动化子池（默认 2，可配），再以非排队方式向主池申请；主池满则在宽限内重试。人工请求永远优先于自动化。
- 硬超时默认 30 分钟，强制开启空闲看门狗。
- 群里运行中不出现任何消息或表情；看板显示“运行中”。

### 5.5 结果与追问
- 结果在 run 结束后一次性发出：普通群为顶层新消息。头部“⏰ 名称 · 时间表 · 由 X 创建”（纯文本，不真实 @），正文为最终答案，页脚提示“在本消息的话题里追问”。v1 结果消息不放按钮。
- agent 已自行把结果发到本群时沿用现有“已发送则跳过”逻辑，fire 记为 delivered-by-agent（此时没有追问根）。
- 追问：在 result post 话题里的回复续接该 fire 的 session 与 cwd（首次接触时预置）；这是人工交互 run，使用交互身份（受限 → 宽松，由人当场发起，可接受；反向永不允许）。引用结果消息回复仍走群 session（现有能力）。
- **注意**：probe 显示普通群里的话题回复不带 thread_id，而本基线的 scope 规则只在话题群里拆 `chatId:threadId`。因此普通群的追问路由不能依赖 thread_id，需按回复的根消息匹配 result post 并给出独立 scope；话题群行为见 §10。

### 5.6 身份与 tool whitelist（D2 的强制手段）
- 自动化 run 优先使用**仅 bot 身份**（独立的 lark-cli 身份配置，不含用户授权），系统提示词使用自动化变体：删除“切换到用户身份”的指引，列出禁止操作。
- **tool whitelist**：bridge 对自动化 run 的 lark-cli 调用按白名单放行（读消息/文档、向本群发消息、读写已共享给 bot 的文档等）；命中人事/组织类能力（建群、成员增删、退群、群设置、通讯录、人事）或请求用户身份时，立即停止 run，`StopRequest` 新增 `policy-guard` 原因，outcome 为 `interrupted(policy-guard)`，群内通知创建者，自动化暂停。
- 每次 fire 的所有 lark-cli 调用写本地审计日志（脱敏，不上卡）。
- 诚实边界：agent 有完整 shell，以上是纵深防御而非安全边界；确认描述中如实写明。若验证发现无法让自动化拿不到用户身份，则必须收紧 bot 应用 scope，且不得宣称“自动化不会使用 owner 身份”。
- 文档类操作：只操作明确共享给 bot 应用的文档。

### 5.7 失败与通知（基于 RunOutcome）
| outcome | 群里 | 其他 | 状态 |
|---|---|---|---|
| `completed` | result post | — | — |
| `partial` | result post，标注“可能不完整” | — | — |
| 可重试的 `failed` / `interrupted`（重启、信号等） | 短通知 @创建者 | — | 连续失败 +1 |
| `failed(auth-required\|quota)` | 短通知，不给重试 | 私聊 bot owner 一次（去重，同 RR D10） | +1 |
| `interrupted(user-stop)` | 短确认 | — | — |
| `interrupted(policy-guard)` | 通知 @创建者 | — | 暂停 |
| 连续 3 次失败 | 通知写明“已自动暂停” | — | 暂停 |
- 永不自动续跑（RR D5）。一次 fire 是一个没有触发消息的 turn，进入 turn journal（区分 automation 与 im 来源），复用未送达重发与孤儿进程检测。

### 5.8 看板
- 同一数据根内：共享注册表 + 锁 + 租约选举 board holder（租约到期或 holder 停止后由下一个写入者接管）。每个 profile 只写自己的部分；holder 渲染并更新卡片，去抖。
- 卡片只读，不放按钮（回调只会到 holder 的 app）。pin 走 im/v1/pins（probe 可用）；pin 失败则请群里手动置顶，只提示一次。
- 接管时 holder 发新卡并 pin，尝试取消旧卡 pin；群内无自动化时卡片显示“暂无”并取消 pin。
- 因只有发送身份能更新卡片（230001），**跨主机/跨数据根的 bot 无法进入同一张卡**，v1 兜底为各自一张卡并注明“本卡只含 X”（见 §10）。

### 5.9 限额
每群每 bot 最多 10 个、每创建者每群最多 5 个（profile 可配）；记录每次 fire 的 usage；描述中给出“每月约 N 次执行”。

### 5.10 F20 修复
backfill 从 session scope 推导 chat id 时，`auto:<id>` 与 `meeting:<id>` 会被截成 `auto` / `meeting` 并送进 chat mode 查询，失败可能把扫描标成 incomplete。验收：只有真实群/私聊 scope（含话题 `chat:thread` 形式）进入 chat mode 查询，`auto:` 与 `meeting:` 永不进入；有回归测试。

## 6. Acceptance criteria

1. 群成员创建自然语言自动化 → 出现描述 + 卡；另一成员点「是」→ 落库，`createdBy` 为请求者、`confirmedBy` 为点击者；描述与落库一致。
2. bot 消息或自动化 run 内产生的提案不会生成 draft。
3. 非创建者（含 bot owner、admin）`/auto edit|pause|delete|run` 被拒；创建者成功。
4. `工作日 09:00` 在周六、周日不触发；时区不随主机时区变化。
5. fire 时群里同时有人工 run：两者并行，人工 run 无可观察延迟，群 session 无自动化内容，群内无 Typing/流式卡/CoT，仅一条 result post。
6. 连续两次 fire 不共享 session；群 `/cd` 后已有自动化 cwd 不变。
7. 自动化 run 调用成员增删/建群/用户身份 → 被阻断，outcome `interrupted(policy-guard)`，自动化暂停，有审计记录。
8. result post 话题里的回复续接该 fire 的 session（普通群与话题群各一例）。
9. 离线错过 3 次后在宽限内恢复：只补跑一次，带延迟标注；超出宽限：不运行，看板显示“错过”。
10. 同数据根两个 profile 同群：只有一张置顶看板，含两个 bot 的条目；holder 停止后另一个接管。
11. backfill 不对 `auto:` / `meeting:` scope 发起 chat mode 查询。
12. 开关关闭时行为与基线完全一致；旧代码忽略自动化存储。

## 7. 测试策略

- 只测外部行为：确定性层（vitest）用现有 recording channel、scripted CLI、fake executable 助手；时间表解析与下次触发为纯函数，注入 `now()`，以 UTC 宿主时区运行表驱动测试。
- 最高测试缝：一个“fire 进、群里可见输出 + journal/日志出”的 channel 级接口；与 run-reliability 的 run outcome / turn journal 集成测试同层。
- 真飞书层使用 `e2e/test-bridge/`（默认 fake CLI，硬围栏），用一次性“1 分钟后”任务覆盖创建→确认→fire→结果→追问，以及卡片、pin、话题行为。证据脱敏，不含任何 ID。

## 8. 开关与回滚

- `automations.enabled`（profile 级，默认关）；看板单独开关，默认关。**在 tool whitelist 与仅 bot 身份落地并验证前，任何线上 profile 不得开启。**
- 自动化存储自带 `schemaVersion: 1`，原子写；未来版本拒绝加载且不覆盖。回滚到旧代码时忽略该存储。

## 9. Out of scope

p2p 自动化；命令型自动化；节假日调休日历；“每 N 分钟”；跨群创建；fire 之间携带上次结果；整机级自动化并发上限；同 cwd 独占；多维表格式跨主机看板（v2 备选）；附件/图片任务内容。

## 10. Open questions / blockers（未验证，需要 test bridge 或开发者控制台）

已有 probe 事实：只有发送身份能更新卡片（230001）；im/v1/pins 可用；普通群里的回复不带 thread_id。

1. **卡片不能跨主机**：跨主机/跨数据根 bot 无法共享一张看板卡。是否接受 v1 每根一张卡的兜底，还是立项多维表格方案？
2. **“任何人可点”需要新令牌类型**：新签名 action 的设计需与 run-reliability D8 对齐，并验证飞书回调里点击者身份的可靠性。
3. **创建者离群后的孤儿自动化**：只有创建者能删 → 无人能删。建议：检测到创建者离群即暂停，暂停中的孤儿允许群主/群管理员删除；需用户拍板，并确认 bot 有读取群成员的权限。
4. **跨 bot 需要 union_id**：open_id 按应用隔离，看板跨 bot 展示创建者需要 union_id；事件中是否可得未验证，拿不到则只显示纯文本名字。
5. **回调 operator 的 open_id**：卡片回调里的点击者 open_id 是哪个应用视角、能否与消息事件中的发送者对应，未验证。
6. **话题群**：结果直接发到话题群是否新建话题；话题群里追问的 scope 与预置行为；普通群追问路由（无 thread_id）的可行性。
7. **线上 bot 的实际 scope**：群消息读取、建群、成员写入、通讯录、人事相关 scope 各 bot 实际持有哪些；仅 bot 身份能否在不放用户授权的前提下完成典型任务；lark-cli 用户授权存放位置能否被隔离。
8. 线上多个 profile 是否共用同一数据根（决定看板选举是否覆盖全部 bot）。
