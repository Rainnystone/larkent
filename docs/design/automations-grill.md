# 设计记录：群内自动化（Automations）Grill

Status：design record（grill 产出，不是 spec，也不含产品代码）。下一步按第 11 节拆票后写 spec。
基线：`master@64addb3`。文中行号以该提交为准。同时参考 `docs/run-reliability` 分支的 `docs/specs/run-reliability.md`（下称 **RR spec**，基线 `master@ee7d60c`）。
方法：按 Matt Pocock 的 `grill-with-docs`（`grilling` + `domain-modeling`）执行。本次是异步评审，没有逐轮等待回答：每个问题都给出推荐答案（➡️），用户已锁定的决策直接标为 locked。仓库和 agent store 里都没有找到上一轮评审的文本，所以下面的事实全部从代码重新推导。

标记约定：
- 【核实 `path:line`】表示在基线代码里读到过。
- 【未验证】表示飞书平台、lark-cli 或线上环境的行为，本仓库代码无法回答，需要 spike 确认（见第 11 节 A0）。
- 【推断】表示根据仓库内文档推出的结论，没有直接证据。

---

## 0. TL;DR

1. **自动化 run 用独立 scope，与人工对话并行，不排队**。scope 键为 `auto:<automationId>`，先例是会议 run 的 `meeting:<id>`。这样 `ActiveRuns`、`PendingQueue`、session、`/stop`、`/new` 天然和群里的人工会话隔离。并发上限靠一个"自动化子池"加主池 `tryAcquire`，保证人工 run 永远不会排在自动化后面。
2. **每次触发（fire）都开新 session**，不续接上一次，也不用群 session。结果由 bridge 一次性发帖：不加 Typing 表情，不开流式卡片，不用 CoT 气泡。这条结果消息就是"续聊话题"的根，人在它的话题里回复，就接着这次 fire 的 session 聊。
3. **内容策略在 v1 只能做到"纵深防御"，做不到安全边界**。agent 默认 `full` 权限，所有 adapter 都自动批准工具调用，而 owner 的用户 token 和 app secret 都在同一个 OS 用户能读到的位置。最有效的一条措施是：**自动化 run 只用 bot 身份**，单独一个 lark-cli 配置目录，里面不放用户 token。这需要先 spike 确认 lark-cli 的 token 存在哪里。另外要指出：同样的风险今天在交互式 @bot 里已经存在。
4. **"一个群一张置顶卡、列出所有 bot"只能部分实现**。飞书卡片只能由发送它的 app 更新【未验证】，所以一张卡只能有一个写者。同一个数据根（`LARK_CHANNEL_HOME`）下的多个 profile 可以靠共享文件 + 锁 + 租约选出一个"看板持有者"来写卡。跨主机或跨数据根的 bot 没有共享通道，只能各自发卡，或者改用飞书多维表格做共享看板。
5. **硬阻断（需要用户知情）**：①跨主机单卡不可行；②"任何人可点 是"和现有签名回调的 operator 绑定冲突，需要新的令牌类型；③"只有创建者能改"会在创建者离群后留下孤儿自动化，需要兜底；④open_id 按 app 隔离，跨 bot 看板必须用 union_id。

---

## 1. 背景与范围

功能：群成员 @bot 后，用自然语言或 `/auto` 命令创建定时任务（自动化）。到点后由该 bot 在后台跑一次 agent，再把结果发回这个群。

v1 范围外（locked）：
- p2p 自动化。
- 命令型自动化，比如定时执行 `/new`。RR spec §9 提到的"每周一 /new"不由本功能实现。
- 节假日调休日历。工作日固定为周一到周五。

---

## 2. 术语（domain-modeling 产出）

本节是给 `CONTEXT.md` 准备的候选词条。这次没有直接改 `CONTEXT.md`，因为 `docs/run-reliability` 分支也在改它，现在改会冲突；等写 spec 时再一起合并。

| 术语 | 定义 | 与现有词汇的冲突 |
|---|---|---|
| **automation**（自动化） | 一条持久记录：绑定一个群和一个 profile（bot），包含时间表、任务提示、创建者、状态。 | 无 |
| **automation creator**（创建者，`createdBy`） | 发出那条促成创建的消息的**人**（自然语言请求者，或 `/auto new` 的发送者）。只有创建者可以编辑或删除。 | **冲突**：`src/policy/access.ts:28-31` 的 `isCreator()` 指的是 **bot owner**（应用所有者）。spec 和代码里要避免 "creator" 这个裸词：自动化一侧一律写 `automationCreator`/`createdBy`，bot 一侧一律写 `botOwner`。建议实现时把 `isCreator` 重命名为 `isBotOwner`。 |
| **bot owner**（bot 所有者） | 飞书应用的所有者，由 `refreshOwnerControls` 拉取（`src/policy/owner.ts:25-45`），持有 CLI 登录和用户身份授权。**对别人创建的自动化没有编辑权。** | 同上 |
| **confirmer**（确认人） | 在确认卡上点"是"的人。可以是群里任何人，不一定是创建者。 | 无 |
| **fire**（一次触发） | 时间表上的一个时刻。一个 fire 最多对应一次 automation run。 | 无 |
| **automation run** | `source: 'automation'` 的 run，**没有触发消息**。 | **冲突**：CONTEXT.md 把 **run** 定义为"one invocation of an agent for one Feishu message"，需要放宽成"一条飞书消息或一次 fire"。 |
| **automation scope** | `auto:<automationId>`，自动化 run 在 `ActiveRuns`、session store 里用的键。 | 与 `chatId` / `chatId:threadId` / `meeting:<id>` 并列 |
| **result post**（结果消息） | bridge 为一次 fire 发到群里的那一条权威消息。 | **冲突**：**bridge-owned final reply** 的定义是"one user turn … to the triggering chat"，需要扩展到 fire。 |
| **follow-up thread**（续聊话题） | 以 result post 为根的飞书话题。话题里的消息续接这次 fire 的 session。 | 无 |
| **scheduler**（调度器） | 按时间表触发 fire 的定时器，归 profile 所有。 | CONTEXT.md 禁止用 "poller/patrol" 描述**恢复**。调度器不是恢复机制，也不轮询飞书，所以不违反这条禁令；但 spec 里要写明它和 backfill 无关。 |
| **grace window**（补跑宽限） | 错过 fire 后仍允许补跑的时长。 | 和 **backfill window** 不是一回事 |
| **automation identity** | 自动化 run 使用的 lark-cli 身份配置（推荐只用 bot）。 | 和 profile 的 `larkCli.identityPreset` 并列 |
| **board**（自动化看板）/ **board holder**（看板持有者） | 每个群一张置顶卡；持有者是唯一负责写这张卡的 bot。 | 无 |
| **draft**（草案） | 等待"是/否"确认的自动化，带 TTL。 | 无 |

ADR 候选（三道门槛都满足：难以回退、没有上下文会让人意外、确实存在取舍）：
- ADR-1：自动化 run 只用 bot 身份（第 4.9 节）。
- ADR-2：每个 fire 开新 session，续聊走话题（第 4.2、4.7 节）。
- ADR-3：看板单写者，靠同数据根文件锁 + 租约选出（第 6 节）。

---

## 3. 代码现状事实（设计的地基）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 每个 bridge 实例有一个 `ProcessPool`，按 FIFO 排队，默认上限 10，最大 50，每次 acquire 都重新读上限。这个池按 profile 划分，**不是整机共享的**。 | 【核实 `src/bot/channel.ts:213`、`src/bot/process-pool.ts:28-43`、`src/config/schema.ts:273-279`】 |
| F2 | `ActiveRuns` 每个 scope 只允许一个 run，`reserve` 失败会抛 `run-already-active`。 | 【核实 `src/bot/active-runs.ts:15-34`、`src/runtime/run-executor.ts:76-79`】 |
| F3 | `submit({ nowait: true })` 走 `tryAcquire`，池满时直接抛 `pool-full`，不排队。 | 【核实 `src/runtime/run-executor.ts:81-91`、`src/bot/process-pool.ts:52-60`】 |
| F4 | 断线或重连期间，`pauseNewRuns` 会让 submit 抛 `reconnect-in-progress`。 | 【核实 `src/runtime/run-executor.ts:70-75`、`src/bot/channel.ts:602`】 |
| F5 | 会议 run 用独立 scope `meeting:<id>`，access 直接放行，与群里的人工 run 并行，共用同一个池。会后纪要只有在 run 结束后才一次性 `channel.send`。这是"后台 run → 发 IM"的现成先例。 | 【核实 `src/meeting/orchestrator.ts:40-41`、`:221-261`、`:291-354`、`:310`】 |
| F6 | session 和 cwd 都按 scopeId 存取：`startRunFlow` 用 `workspaces.cwdFor(scopeId)` 解析 cwd，再按 catalog（带 policy fingerprint）或 SessionStore 找 resume handle。 | 【核实 `src/bot/run-flow.ts:79-128`】 |
| F7 | policy fingerprint 里的 `resourceScopeDigest` 由 `source/chatId/threadId/...` 组成，`ScopeContext.source` 现在的取值是 `'im'\|'card'\|'comment'\|'meeting'`。 | 【核实 `src/policy/run-policy.ts:20-27`、`:116-127`、`src/policy/fingerprint.ts:16-22`、`:75-83`】 |
| F8 | 只要 IM 消息带 `threadId`，就按 topic 处理，scope 变成 `chatId:threadId`，**普通群也一样**。 | 【核实 `src/bot/channel.ts:792`、`:801-803`】 |
| F9 | 首次进入某个 topic scope（这个 scope 还没有 session）时，bridge 会抓最多 40 条话题上文，作为 `topic_context` 注入。 | 【核实 `src/bot/channel.ts:1010-1023`】 |
| F10 | Typing 表情只在非卡片、非 CoT 模式下加在触发消息上；CoT 气泡需要 `originMessageId`。自动化没有触发消息，这两样都不适用。 | 【核实 `src/bot/channel.ts:1215-1216`、`:1227`、`src/bot/reaction.ts:15-30`】 |
| F11 | 卡片回调签名绑定了 `runId/scope/chatId/operatorOpenId/action/fingerprint`；校验时要求该 scope 的 run **仍在运行**，并且点击者等于签名里的 operator。 | 【核实 `src/card/callback-auth.ts:133-145`、`src/card/dispatcher.ts:206-240`、`src/bot/channel.ts:1196-1209`】 |
| F12 | managed card 的 messageId 到 cardId 映射只存在内存里，重启就丢。 | 【核实 `src/card/managed.ts:10-12`】 |
| F13 | 默认权限是 `full`；Cursor 固定 `--force --sandbox disabled`，agy 用 `--dangerously-skip-permissions`，Claude 默认 `bypassPermissions`，Codex 用 `approval_policy="never"`。 | 【核实 `src/config/permissions.ts:176-181`、`src/agent/cursor/argv.ts:20-51`、`src/agent/antigravity/argv.ts:44-56`、`src/agent/claude/options.ts:7`、`src/agent/codex/argv.ts:24-28`】 |
| F14 | lark-cli 身份策略（strict-mode / default-as）写在 **profile 级** 的 lark-cli 配置目录里，不是每次 run 单独设置。所有 run 共用这个目录。 | 【核实 `src/lark-cli/identity-policy.ts:37-50`、`src/config/app-paths.ts:66`、`src/agent/lark-channel-env.ts`】 |
| F15 | 6 个 adapter 都在实例层用 `buildLarkChannelEnv(this.larkChannel)` 构造子进程环境；`AgentRunOptions` 没有逐 run 的 env 或身份字段。 | 【核实 `src/agent/types.ts:31-49`、`src/agent/cursor/adapter.ts:108`、`src/agent/codex/adapter.ts:125-146` 等】 |
| F16 | bridge 系统提示词是一个常量，按 adapter 实例注入。里面教 agent 在需要时自己执行 `strict-mode off` 来切到用户身份。 | 【核实 `src/agent/bridge-system-prompt.ts:109-112`、`:130-135`；注入点 `claude/adapter.ts:81`、`cursor/adapter.ts:102` 等】 |
| F17 | owner 的用户身份申请了 `im:chat.members:write_only`（加成员）；bot 身份能建群（`/new chat`）。 | 【核实 `src/lark-cli/user-im.ts:60-61`、`:334-343`、`src/bot/group.ts:21`】 |
| F18 | 默认 `mode: 'team'`，`canUseGroup` 对任何人都放行；只有 personal 模式才看 `allowedChats`。 | 【核实 `src/config/profile-schema.ts:336`、`src/policy/access.ts:47-58`】 |
| F19 | `/stop <scope>` 是管理员专用的定向停止，可以停任意 scope（包括将来的 `auto:`）；不带参数时只停当前 scope。 | 【核实 `src/commands/index.ts:741-764`】 |
| F20 | backfill 会把所有 session scope 用 `chatIdFromScope` 取冒号前那段，当作 chat id 去查 chat mode。`meeting:<id>` 会变成 `meeting`，将来的 `auto:<id>` 会变成 `auto`。 | 【核实 `src/bot/backfill.ts:555-571`、`:621-624`、`src/bot/channel.ts:412-415`】这是潜在 bug：查询失败时如果拿不到 HTTP 状态码，会被算作 unresolved，可能把扫描标成 incomplete（`:539-548`）。meeting 线上的实际影响【未验证】。 |
| F21 | bridge 已经能从 `tool_use` 事件里解析 `lark-cli` 的 argv（目前用于识别"agent 已经自己发过 IM"）。 | 【核实 `src/card/direct-im-send.ts:25-42`】 |
| F22 | adapter 会发出 `usage` 事件（token 数、`costUsd`），覆盖面按 adapter 不同。 | 【核实 `src/agent/types.ts:17-23`】 |
| F23 | supervisor 在一个进程里托管多个 profile；`/reconnect` 时把同一批 store 注入新的 `startChannel`（ledger 就是这样跨重启存活的）。 | 【核实 `src/runtime/supervisor.ts:288-297`、`:376`、`:461-475`】 |
| F24 | 同一数据根下的所有 profile 共用 `registry/locks` 目录；依赖里已经有 `proper-lockfile`。 | 【核实 `src/config/app-paths.ts:50-51`、`:75-80`、`package.json`】 |
| F25 | channel SDK 有 `updateCard`、`createCard`、`updateCardById`、`recallMessage`，**没有 pin 或置顶的封装**，只能通过 `rawClient` 调原生 API。 | 【核实 `@larksuite/channel@0.7.1` 的 `index.d.mts`：`updateCard`、`createCard`、`recallMessage`、`rawClient`】 |
| F26 | 运行空闲看门狗默认关闭；开启后上限 120 分钟。 | 【核实 `src/config/schema.ts:317-322`】 |

---

## 4. 核心：自动化怎么跑

### 4.1 run 形态

❓ **Q1 - scope 键怎么定**：自动化 run 用什么 scopeId？
- (a) 复用群 scope（`chatId`）：会和人工 run 互斥（F2），并且续接群 session。
- (b) 每个自动化一个 `auto:<id>`。
- (c) 每次 fire 一个 `auto:<id>:<fireId>`。

➡️ **(b)**。`ActiveRuns` 以 `auto:<id>` 为键，同一个自动化同时只有一个 fire 在跑，上一次还没跑完时下一次直接记为"跳过：上次仍在运行"，这一点由 F2 免费得到。session 每次 fire 都清空重来（见 Q4），所以不需要 (c) 那样的 per-fire scope；需要续聊时再把 resume handle 拷到话题 scope（第 4.7 节）。

❓ **Q2 - run 的 source 和 actor**：`ScopeContext.source` 增加 `'automation'`；`actorId` 填创建者的 open_id；`chatId` 填目标群。fire 时**重新评估** `canUseGroup(profile, controls, chatId, createdBy)`，不通过（比如 personal 模式下这个群已被移出白名单）就暂停该自动化。

➡️ 是。fingerprint 加入新的 source 值，只会产生新的 digest，不影响已有 digest 的稳定性（F7 的 V2 契约针对的是已有输入）。会议 run 那种直接放行 access 的做法（F5 `:310`）**不适合**照搬：自动化的权限来自"创建者是群成员"，要在每次 fire 时重新核验。

❓ **Q3 - cwd**：自动化在哪个目录跑？
- (a) 跟随群 scope 当前的 `/cd` 绑定（实时）。
- (b) 创建时快照群 scope 的 cwd，写进自动化记录；每次 fire 再用 `resolveWorkingDirectory` 校验。
- (c) 固定用 profile 默认工作区。

➡️ **(b)**，并把 cwd 写进确认描述，让确认人看得到。`/cd` 是管理员命令（`src/commands/index.ts:182-196`）；如果实时跟随，管理员一次 `/cd` 就会悄悄改变别人自动化的执行目录。

### 4.2 session 隔离与上下文污染（双向）

❓ **Q4 - fire 之间要不要共享 session**？
- (a) 每次 fire 都开新 session（不 resume）。
- (b) 每个自动化一个长期 session，每次 fire 都续接。
- (c) 续接群 session。

➡️ **(a)**。理由：
- (b) 的上下文会无限增长，成本逐日上升，CLI 还会自动压缩上下文，导致不可预期的行为；"昨天的结论"也会污染今天的判断。
- (c) 直接违反用户"不得干扰人工对话"的要求：会和人工 run 互斥，会往人工 session 里写自动化内容，还会把群里人工讨论的上下文带进无人值守的任务。

如果某个任务确实需要"和上次对比"，v2 可以把上次 result post 的正文截断后作为 `bridge_instructions` 注入，而不是续接 session。

实现上，fire 前对 `auto:<id>` 执行 catalog `archiveActive` 并清空 SessionStore。fire 的 resume handle 通过 `recordRunSessionEvent` 正常写入（`src/bot/run-flow.ts:178-191`），供续聊时拷贝。

**自动化 → 人工会话：污染点清单**

| 通道 | 结论 | 依据 |
|---|---|---|
| session / catalog | 隔离：scopeId 不同 | F6 |
| `PendingQueue` | 隔离：自动化不经过消息队列，群里的人工消息不会被它阻塞或合并 | `src/bot/pending-queue.ts`；flush 只由消息触发（`channel.ts:316-369`） |
| `activePolicyFingerprints`、`lastRunModelByScope` | 隔离：都按 scope 存 | `channel.ts:1133`、`:1036-1038` |
| Typing 表情、CoT 气泡、流式卡片 | 不出现：自动化没有触发消息，并强制只发最终答案 | F10 |
| 群里的 `/stop`、`/new` | 不影响自动化：两者都只作用于当前 scope | F19；`handleNew` 调 `supersedeSession(ctx.scope)` |
| 群 session 看不见结果 | 这是**有意为之**：人要接着聊，就引用 result post（会注入 `quoted_message`）或者在它的话题里回复 | `channel.ts:2075-2088`、F8 |
| backfill | **需要修**：`auto:` scope 不能进入 chat mode 查询 | F20 |

**人工会话 → 自动化：污染点清单**

| 通道 | 结论 |
|---|---|
| 群 session 历史 | 不注入。需要群上下文时，任务提示里明确要求 agent 用 bot 身份 `lark-cli` 读群历史（bot 是否有群消息读取 scope【未验证】）。 |
| 群 `/cd` | 不跟随（Q3 选 b）。 |
| profile 配置（模型、权限） | 下一次 fire 生效。每次 fire 都是新 session，不存在"模型切换提示"的问题。 |

### 4.3 与人工 run 的并发

❓ **Q5 - 同群有人工 run 在跑时，自动化排队还是并行**？

➡️ **并行**。理由：
- scope 不同，`ActiveRuns` 本来就不冲突（F2）。
- 如果排在人工 run 后面，自动化的延迟没有上界：RR spec 附录 A 记录过 41–92 分钟的单次 run。
- 如果反过来让人工 run 排在自动化后面，就违背"不干扰"的要求。

**剩余风险**：两个 run 在同一个 cwd 里同时写文件，会互相踩（CONTEXT.md 写明 "this is not filesystem … isolation"）。v1 在确认描述里提示这一点；v2 可以考虑给自动化加"独占工作目录"选项。

❓ **Q6 - 进程池**：自动化怎么占用 `ProcessPool`？

➡️ 两层控制：
1. **自动化子池**：每个 profile 新建一个 `ProcessPool`，上限默认 2（可配置），自动化 run 先拿子池的槽位。
2. **主池用 `nowait`**：拿到子池槽位后，向主池提交时用 `submit({ nowait: true })`（F3）。池满就抛 `pool-full`，调度器在宽限窗口内每 30 秒重试一次。主池释放槽位时会先唤醒排队中的人工 waiter（`process-pool.ts:62-71`），自动化的 `tryAcquire` 只有在没人排队时才可能成功，所以**人工请求永远优先**。

附加措施：
- 同一分钟内的 fire 按 automation id 哈希加 0–60 秒的确定性抖动，避免整点雪崩。显示时仍用计划时间。
- 池是按 profile 划分的（F1），3 个 profile 同时在 09:00 触发就可能起 3×2 个进程。整机级的自动化信号量留作开放项（D-O9）。

❓ **Q7 - 断线、重连期间到点**：

➡️ `reconnect-in-progress`（F4）不算失败。fire 留在调度器队列里，等恢复后在宽限窗口内重试。调度器归 `ManagedProfile` 所有，像 ledger 一样注入 `startChannel`（F23），这样 `controls.restart()` 不会让它重复触发或丢失状态。同一个 profile 不可能同时被两个进程运行（profile 锁 + app 锁，`src/runtime/locks.ts`），所以调度器天然只有一个所有者。

### 4.4 群里看到什么

❓ **Q8 - 运行中显示什么**？
- (a) 什么都不显示。
- (b) 到点先发一条"⏰ 开始执行"，结果作为它的话题回复。
- (c) 只在看板卡上显示"运行中"。

➡️ **(a) + (c)**。群里不出现新消息，也不加表情；看板（第 6 节）上该条显示"运行中 · 自 09:00"。(b) 每次 fire 会产生两条消息，在有多个自动化的群里噪音翻倍。

❓ **Q9 - 结果消息的格式和位置**？

➡️
- **位置**：普通群里作为一条**顶层新消息**（不 `replyTo` 任何消息）；topic 群里直接发到群，会自动成为一个**新话题**（【未验证】：不带 `replyTo` 发到 topic 群是否一定新建话题，需在 A0 中确认）。
- **格式**：一张结果卡（或 markdown，跟随 profile 的 `messageReply` 设置，但**总是只发最终答案**）。
  - 头部：`⏰ <名称> · <时间表> · 由 <创建者> 创建`。为了避免每天提醒，创建者显示为纯文本，不用真实 @。
  - 正文：agent 的最终文本。
  - 页脚：`在本消息的「回复话题」里继续追问 · 管理：@bot /auto`。如果是延迟执行，再加一行 `原定 09:00 · 因 bot 离线延迟 47 分钟`。
- **按钮**：v1 不放。卡片按钮需要第 5.3 节那种"不绑定运行中 run"的新令牌，先只给确认卡用。
- **agent 自己发了 IM**：沿用 `outbound.skip-cli-already-sent`（`src/card/direct-im-send.ts`）。automation run 的 `currentChatId` 填目标群，跳过逻辑照常生效。但这样就没有 result post 作为续聊话题根了，需要在 run 记录里标为 `delivered-by-agent`。

### 4.5 中断与失败通知

依赖 RR spec 的 ticket 2（RunOutcome）和 ticket 3（interruption notice）。

❓ **Q10 - 失败时群里看到什么，通知谁**？

➡️
| outcome | 群里 | 私聊 | 自动化状态 |
|---|---|---|---|
| `completed` | 结果消息 | — | 不变 |
| `partial` | 结果消息，标注"可能不完整" | — | 不变 |
| `failed(transient-upstream)`、`interrupted(keepalive-restart\|shutdown-signal\|external-signal)` | 一条短通知，@创建者，带"重新执行"按钮 | — | 连续失败计数 +1 |
| `failed(auth-required\|quota)` | 一条短通知，@创建者，**不给**"重新执行"按钮 | **私聊 bot owner 一次**（去重），沿用 RR D10。CLI 登录归 owner 管，不归创建者 | 计数 +1 |
| `interrupted(user-stop)`（创建者执行 `/auto stop`，或管理员 `/stop auto:<id>`） | 一条短确认 | — | 不变 |
| 连续 3 次失败 | 通知里写明"已自动暂停" | — | 暂停 |
| bot 被移出群、或者创建者已离群 | 发不出去，或者不发 | 私聊创建者一次 | 暂停 |

自动化是无人值守的，**不会自动续跑**，这和 RR D5 一致。"重新执行"是开一次全新的 fire，不续接被中断的 session；这次 fire 可能已经产生了副作用，重新执行的提示里要写"上次在 X 时被中断，请先核对已完成的步骤"。谁可以点"重新执行"见 D-O5。

### 4.6 补跑宽限

❓ **Q11 - bot 离线错过 fire 怎么办**？

➡️
- 每个自动化有一个 `graceMinutes`，**默认 120**，可设为 0–720。
- 重启或唤醒后，调度器用持久化的 `lastFireAt` / `nextFireAt` 算出错过的 fire：
  - 只补**最近一次**，多次错过合并成一次补跑；
  - 如果下一次正常 fire 早于宽限截止时间，就不补跑。
- 补跑时给 agent 注入一条延迟提示（套用 backfill 的 `formatBackfillLatenessHint`，见 `channel.ts:1046-1055`），结果卡页脚标注延迟时长。
- 超出宽限的错过：群里不发消息，看板上显示"错过 09:00"。不私聊创建者（避免噪音）。
- 调度器的唤醒检测复用 keepalive 的 wake-up 信号（`channel.ts:589`），不新增轮询。

### 4.7 续聊

❓ **Q12 - 人怎么接着结果继续聊**？
- (a) 在结果消息的话题里回复，接着 fire 的 session 聊。
- (b) 引用结果消息回复，进入群 session，把结果作为 `quoted_message` 注入。
- (c) 引用结果并路由到 fire 的 scope（覆盖普通群的 scope 规则）。

➡️ **(a) 为主、(b) 为辅，不做 (c)**。
- (a) 能成立的依据是 F8：带 `threadId` 的消息自动进入 `chatId:threadId` scope，与群 session 隔离。
- 实现方式：记录 `resultMessageId → fire`（含 resumeHandle、cwd、agentKind）。intake 时，如果消息的 `rootId` 等于某个 resultMessageId，并且这个话题 scope 还没有 session，就**在首次接触时预置**：
  - SessionStore：为话题 scope 写入 resume handle；
  - catalog：在**话题 scope 自己的** fingerprint（`source:'im'`、带 threadId）下 upsert，因为 Codex 只认 catalog（`run-flow.ts:113-121`）；
  - WorkspaceStore：把话题 scope 的 cwd 设成 fire 的 cwd。Claude 的 session 按 cwd 存放，cwd 不一致就会 resume 失败并 `sessions.clear`（`run-flow.ts:122-127`）。WorkspaceStore 对 `chatId:threadId` 是否会回落到 chat 级映射【未验证】。
- 预置失败时的兜底：话题首次接触会抓话题上文（F9），根消息就是结果正文，agent 至少能看到结果。
- 续聊是**人工交互 run**，使用交互身份。这意味着用 bot-only 身份创建的 session 会在人工身份下继续。方向是"从受限到宽松"，并且由人当场发起，可以接受；反方向（人工 session 进入自动化）永远不允许。
- (b) 是现有能力，不需要改。(c) 会让同一个群里出现两套 scope 规则，用户很难理解。
- 【未验证】：飞书普通群里的"回复话题"消息是否一定带 `thread_id`，A0 需要确认。

### 4.8 成本与限额

➡️ v1 默认值，profile 级可配置：
- 每个群、每个 bot 最多 10 个自动化；每个创建者在每个群最多 5 个。
- 时间表粒度：每天、工作日、每周某几天；每天最多 4 个时刻；可选一次性定时。v1 不支持"每 N 分钟"。
- 单次 fire 的硬超时默认 30 分钟，强制开启空闲看门狗（F26 默认关闭，自动化不受这个默认值影响）。
- 每次 fire 记录 `usage` 事件的 token 和 `costUsd`（F22，覆盖面因 adapter 而异），写入 run 记录；看板可以显示"上次耗时"。
- 确认描述里给出估算："每月约 N 次执行"。

### 4.9 内容策略怎么真正执行

用户要求：自动化**不得**做人事或组织操作（加人、踢人、建群、招聘、解雇、入群、退群）。文档、wiki、文件的规则见 D-O1。

**先说结论**：在 F13（agent 拥有完整 shell）和 F14（身份按 profile 设置）的前提下，v1 只能做到"防误用、可审计"，做不到对抗恶意提示词的安全边界。还有一个关键事实：**这个风险今天在交互式 @bot 里已经存在**。在 team 模式下（F18），任何群成员都可以直接让 bot 用 owner 身份加人（F17），自动化并没有引入新能力，只是让这件事可以无人值守地发生。

分层方案（从强到弱）：

| 层 | 手段 | 强度 | 依据与缺口 |
|---|---|---|---|
| L1 app scope | 检查 bot 应用的权限范围。如果没有建群、成员写入、通讯录或人事相关 scope，bot 身份在平台层面就做不了这些操作 | 强，但按 app 生效，无法只针对自动化；而 `/new chat` 需要建群权限（F17） | 线上 app 实际有哪些 scope【未验证】 |
| L2 自动化身份 | 自动化 run 使用**单独的 lark-cli 配置目录**（如 `profiles/<p>/lark-cli-automation/`），设为 `strict-mode bot` + `default-as bot`，从不在里面执行 `auth login` | 中：拿不到 owner 用户 token，就做不了 F17 里的加成员 | ①需要给 `AgentRunOptions` 加逐 run 的身份或 env 字段，并改 6 个 adapter（F15）；②**lark-cli 的用户 token 存在配置目录里还是 OS keychain**【未验证，最关键】。如果在 keychain 并按 app id 共享，L2 就退化成只靠 strict-mode，而 agent 能自己改回 strict-mode；③agent 有完整 shell，可以读主配置目录或 app secret（`lark-cli-source/config.json`），所以 L2 防的是误用，防不住恶意 |
| L3 系统提示词变体 | 自动化 run 使用专门的提示词：删掉 OAuth 和 `--as user` 的指引（F16 的第 5 步会教 agent 关掉 strict-mode，**必须删除**），并写明禁止操作的清单 | 弱，只是提示词层面 | 提示词按 adapter 实例注入（F16），需要和 L2 一样改成逐 run 选择 |
| L4 运行时守卫 | 复用 F21 的 argv 解析，在自动化 run 里发现 `lark-cli` 的成员、建群、通讯录、人事类子命令或 `--as user` 时，立即停止 run（stop reason `policy-guard`，需要扩展 RR ticket 2 的枚举）并发通知 | 弱到中：可以被 shell 间接调用、脚本或 curl 绕过；`tool_use` 事件和真实执行之间存在竞态 | 子命令名单需要对照 lark-cli 的实际命令【未验证】 |
| L5 创建时筛查 | 自然语言提案和 `/auto` 的任务文本做关键词筛查；确认描述写明"执行身份：bot（不使用 owner 个人身份）" | 弱 | — |
| L6 审计 | 每次 fire 记录所有 `lark-cli` 调用的 argv，写入本地日志（脱敏，不上卡片） | 事后追查 | — |

➡️ **推荐**：v1 上线的门槛是 **L2 + L3 + L4 + L6**，并且 A0 spike 要先证明 L2 确实拿不到用户 token。如果 spike 发现 token 在共享的 keychain 里，就**不要**在 v1 宣称"自动化不会使用 owner 身份"，改为如实告知用户，并把 L1（收紧 app scope）列为必要条件。另外建议开一张后续票，把同样的 L3/L4 用到群里的交互式 run 上，因为风险本来就在那里。

### 4.10 调度器生命周期

- 存储：`profiles/<p>/automations.json`，自带 `schemaVersion: 1`，原子写，遵守 CONTEXT.md 的 Persistence rules（未来版本拒绝加载，不覆盖原文件）。fire 历史有界保留。
- 与 turn journal（RR ticket 4）的关系：一次 fire 就是一个**没有触发消息的 turn**，journal 增加 `kind: 'automation'`。这样 restart 后可以复用"完成但未送达"的重发和孤儿进程检测。在 journal 落地之前，结果送达失败只在内存里重试 3 次，然后记日志。
- 开关：`automations.enabled`，按 profile 设置，默认关闭。

---

## 5. 创建、确认、管理

### 5.1 权限矩阵（创建者和 bot owner 分开写）

| 动作 | 创建者 | bot owner | 其他群成员 | profile admins |
|---|---|---|---|---|
| 创建（自然语言或 `/auto new`） | ✅（任何能 @bot 并通过 `canUseGroup` 的**人**；bot 发出的消息不行） | ✅（以普通群成员身份；创建后就是创建者） | ✅ | ✅ |
| 点"是 / 否"确认**创建** | ✅ | ✅ | ✅（locked：故意放宽） | ✅ |
| 编辑、暂停、恢复、删除 | ✅ **只有创建者** | ❌（除非他本人就是创建者） | ❌ | ❌ |
| 立即执行（`/auto run`） | ✅ | ❌ | ❌ | ❌ |
| 停止正在跑的 fire | ✅ `/auto stop` | ✅ 现有的 `/stop auto:<id>`（F19，停止不等于编辑，作为安全阀保留） | ❌ | ✅ 同 owner |
| 失败后"重新执行" | 见 D-O5 | 见 D-O5 | 见 D-O5 | 见 D-O5 |
| 收到 auth / quota 告警私聊 | — | ✅ | — | — |

说明："bot owner 不能编辑"是**聊天层面的规则，不是安全边界**。owner 能登录主机，可以直接修改 `automations.json`。

### 5.2 `/auto` 语法（locked：用 `|` 分隔）

```
/auto                                   列出本群中本 bot 的自动化（任何人可用）
/auto new <时间表> | <名称> | <任务>      创建（同样进入确认流程，见 D-O3）
/auto show <编号>                        查看完整描述
/auto edit <编号> <时间表> | <名称> | <任务>   某一段写 - 表示不改（仅创建者）
/auto pause|resume|delete|run|stop <编号>   仅创建者（stop 另见 5.1）
```

- 只按**前两个** `|` 切分，之后的所有内容都算任务文本，所以任务里可以包含 `|`。
- 时间表语法：`每天 HH:MM`、`工作日 HH:MM`（周一到周五，locked）、`每周一三五 HH:MM`；多个时刻用逗号分隔，最多 4 个；`一次 YYYY-MM-DD HH:MM`。
- 时区：存为 IANA 时区名，默认取 profile 级偏好 `automations.timezone`，再默认 `Asia/Shanghai`。云主机常常运行在 UTC，所以不用主机时区。
- 要求 @ 的群里，`/auto` 也必须 @bot（`channel.ts:844-852` 不豁免斜杠命令）。p2p 里的 `/auto` 直接回复"v1 仅支持群"。
- `/auto` **不放进** `ADMIN_COMMANDS`（`src/commands/index.ts:182-196`），创建者校验在 handler 内部做。

### 5.3 自然语言创建 → 描述 + 是/否卡

❓ **Q13 - agent 怎么把"意图"交给 bridge**？
- (a) agent 在最终回复里输出一个 `<automation_proposal>{json}</automation_proposal>` 块，bridge 提取、校验后从回复里删掉。
- (b) 新增一个本地子命令 `lark-channel-bridge automation propose`，由 agent 调用。
- (c) bridge 自己做意图识别。

➡️ **(a)**。理由：6 个 agent 不需要额外的工具就能用；从 `final_text` 里删掉特定块已有先例（`src/agent/antigravity/envelopes.ts`）；校验完全在 bridge。JSON 格式错误时，bridge 回复"没能解析成自动化，请用 `/auto new …`"。

流程：
1. 只在群里、并且请求者是人（`senderType: 'user'`）时接受提案；**请求者成为创建者**（批次里有多个发送者时，取最后一条人类消息的发送者，与 RR §9 的 initiator 定义保持一致）。
2. 群的人工 run 正常结束后，bridge 从提案生成 draft（`automation-drafts.json`，TTL 24 小时），然后发**两条**消息：
   - **文字消息**：agent 的回复（已删掉提案块），后面接一段**由 bridge 根据 draft 确定性渲染**的完整描述：名称、时间表、时区、接下来 3 次执行时间、目标群、创建者、执行身份（bot）、cwd、补跑宽限、超时、并发说明、结果发到哪里、谁能编辑或删除、任务原文。用户确认的内容必须和最终存下来的完全一致，所以描述不由模型自由生成。
   - **确认卡**：`是 / 否` 两个按钮。
3. 按钮使用**新的令牌类型**（`bridge_cb.automation-draft.v1`），绑定 `draftId + chatId + action + nonce + exp`，**不绑定 operator**，也不要求有运行中的 run（F11 的现有令牌两条都要求，不能直接用）。校验时检查：签名、未过期、nonce 只用一次、draft 仍是 pending、点击者通过该群的 `canUseGroup`（如果 RR 0a 的围栏已启用，也要过围栏）、点击者是人。
4. 点"是"：保存为正式自动化，`confirmedBy` 记录点击者。卡片更新为"已由 <确认人> 确认创建"。managed 映射重启会丢（F12），所以 draft 里持久化 messageId，更新时退回 `updateCard(messageId)`。然后更新看板。点"否"：draft 作废，卡片更新为"已取消"。
5. 自然语言的**编辑或删除**提案也走同样的卡片，但只有创建者能点"是"（D-O3）。

---

## 6. 每个群一张置顶看板（多 bot 协调）

### 6.1 约束

- C1：飞书消息卡片只能由发送它的 app 更新；CardKit 卡片实体也只能由创建它的 app 更新【未验证，A0】。所以**一张卡只能有一个写者**。
- C2：bot 之间收不到对方未 @ 自己的群消息（`bridge-system-prompt.ts:29`）。用 bot 互相 @ 来协调会产生噪音和死循环，SDK 为此专门做了 `botLoopGuard`（F25 同一文件）。**不采用**这种方式。
- C3：open_id 按 app 隔离，同一个人在 bot A 和 bot B 下的 open_id 不同。看板要跨 bot 展示创建者，就得用 **union_id**；事件里是否带 union_id【未验证，A0】。拿不到时只显示纯文本名字。
- C4：SDK 没有 pin 的封装（F25），需要通过 `rawClient` 调 pin API。所需 scope、谁能取消别人的 pin、"Pin"和"群置顶"的权限差异，都【未验证】。
- C5：卡片可能只能在发出后 14 天内更新【未验证】。

### 6.2 方案

**P1（推荐，适用于同一数据根）**：共享文件 + 单写者租约。
- 注册表：`<rootDir>/automation-boards/<hash(chatId)>.json`，用 `proper-lockfile` 加锁（F24）。supervisor 托管的 profile 和各自独立运行的 `start` 服务都共用同一个 rootDir，这个方案对两种运行方式都成立。
- 结构：
  - `holder: { appId, profile, leaseExpiresAt }`
  - `card: { messageId, cardId, sequence, postedAt, pinned }`
  - `sections: { [appId]: { botName, updatedAt, automations: [{ id, name, scheduleText, tz, nextFireAt, status, creatorUnionId?, creatorName }] } }`
- **写**：每个 profile 只写自己的 section。触发时机：创建、编辑、暂停、删除，以及 fire 开始和结束时的状态变化。
- **选举**：写入时如果没有 holder，或者 holder 租约已过期，写入者自己成为 holder。租约 10 分钟，holder 运行期间每 3 分钟续一次。profile 停止时主动释放租约。
- **渲染**：holder 监听注册表变化（`fs.watch` 加 60 秒兜底），去抖 5 秒后执行 `updateCardById`。卡片只读、不放按钮，因为按钮回调只会送到 holder 自己的 app，不是自动化所属的 bot。
- **接管**：新 holder 发一张新卡并 pin，尝试取消旧卡的 pin（可能因为权限失败【未验证】）。旧卡页脚一直写着"更新于 HH:MM · 若长时间未更新，请以最新置顶为准"。
- **14 天问题**：holder 在第 13 天，或者更新失败时，重新发卡并重新 pin（C5）。
- **清空**：群里没有任何自动化后，卡片更新为"本群暂无自动化"并取消 pin。
- **pin 失败**：卡片照发，然后在群里请人手动置顶，只提示一次。

**同一数据根之外的 bot（跨主机或跨 `LARK_CHANNEL_HOME`）**：没有共享通道。
- P2（v1 的兜底）：这类 bot 各自维护一张看板卡，卡上注明"本卡只含 <bot>"。等于在这一部分退回到用户否决过的"每个 bot 一张卡"，这是**硬阻断**，需要用户知情。
- P3（v2 备选）：用飞书多维表格做共享注册表。每个 bot app 都要被授予编辑权限，并新增 `bitable` scope；"看板"变成 pin 一个表格链接或群 tab，不再是卡片。好处是原生支持多写者，跨主机也能用。

➡️ v1 只做 P1，P2 作为自动兜底。线上的多个 profile 是否在同一个数据根下【推断：RR spec 附录 A 写着"三个 profile 合计"，像是同一台机器上的同一个根，需要确认】。

---

## 7. 硬阻断与冲突（需要用户知情）

| # | 冲突 | 影响 | 建议 |
|---|---|---|---|
| B1 | "任何群成员都能创建" + "bot 带 owner 个人身份" + 无人值守 | 任何人都能安排一个以 owner 身份执行的定时操作 | 自动化只用 bot 身份（L2）。这**不改变**交互式 run 继续使用 owner 身份的现状。前提是 A0 证明 L2 有效 |
| B2 | 一个群一张卡 vs 飞书单写者限制 vs 多主机部署 | 跨根的 bot 无法进入同一张卡 | P1 加 P2 兜底；如果跨主机是刚需，改走 P3 |
| B3 | "任何人可点 是" vs 现有回调令牌绑定 operator 和运行中的 run（F11） | 现有机制做不到 | 新令牌类型（5.3 第 3 步），与 RR D8 的"不绑定运行中 run 的签名 action"共用基础设施 |
| B4 | "只有创建者能改" vs 创建者离群或离职 | 孤儿自动化没人能删 | fire 时如果检测到创建者不在群里就自动暂停；暂停中的孤儿允许**群主或群管理员**删除（D-O4） |
| B5 | open_id 按 app 隔离 | 跨 bot 看板上的创建者 @ 会错 | 使用 union_id，拿不到就退回纯文本（C3） |
| B6 | 内容策略 vs 完整 shell 权限 | 无法提供安全边界 | 如实写进 spec 和确认描述（4.9 节） |

---

## 8. Locked decisions

- L-1：任何能 @bot 的群成员（通过 `canUseGroup` 的人类）都可以创建自动化。
- L-2：内容策略禁止人事和组织操作（加人、踢人、建群、招聘、解雇、入群、退群）。执行强度见 4.9 节，B6 需要用户知情。
- L-3：只有**自动化创建者**可以编辑或删除；**bot owner 不行**（除非他本人就是创建者）。
- L-4：自然语言创建时，bot 回复完整描述加一张"是 / 否"卡，**群里任何人都可以点**。
- L-5：工作日 = 周一到周五；`/auto` 用 `|` 分隔。
- L-6：每个群一张看板，覆盖所有 bot。受 B2 限制，按第 6 节实现。
- L-7：v1 不支持 p2p 自动化，不支持命令型自动化。

## 9. Open decisions（附推荐）

❓ **D-O1 - 文档、wiki、文件的规则（用户原话"虽然都需要拥有编辑权"有歧义）**：
- (I1) 只能操作**创建者**有编辑权的文档。bot 拿不到创建者的身份，没法核验，**不可行**。
- (I2) 只用 bot 身份操作，所以只能操作**明确共享给 bot 应用**的文档；能把文档共享给 bot 的人本身就需要有分享或编辑权，正好对应"需要拥有编辑权"。
- (I3) 用 owner 身份，owner 能编辑的都能操作。任何群成员都可以通过自动化改写或删除 owner 的私人文档，**风险高**。
- (I4) 自动化对已有文档只读，只能写入自己新建的文档。

➡️ **I2**，并与 L2 一致。把"要让自动化编辑文档，先把文档分享给 bot"写进确认描述。

❓ **D-O2 - 执行身份**：自动化 run 只用 bot 身份？ ➡️ 是（ADR-1）。代价是读不到只有 owner 能看的文档或聊天记录。

❓ **D-O3 - `/auto new` 是否也走确认卡；编辑和删除提案谁能确认**？ ➡️ `/auto new` 也走确认卡，两条入口保持一致，确认卡仍然任何人可点。编辑和删除只有创建者能确认。

❓ **D-O4 - 孤儿自动化的兜底**？ ➡️ 创建者不在群里时自动暂停；暂停中的孤儿可以由群主或群管理员删除。不开放给 bot owner，以保持 L-3 的语义；需要的话 owner 仍可以在主机上处理。

❓ **D-O5 - 失败后"重新执行"谁能点**？ ➡️ 群里任何被允许使用 bot 的人，与 RR D6 一致；每个 fire 只允许重新执行一次。

❓ **D-O6 - 结果是否 @ 创建者**？ ➡️ 成功时不 @，失败时 @。

❓ **D-O7 - 补跑宽限的默认值**？ ➡️ 120 分钟，每个自动化可在 0–720 分钟之间设置；只补最近一次。

❓ **D-O8 - fire 之间是否携带上次结果**？ ➡️ v1 不携带；v2 作为可选项，注入截断后的上次正文。

❓ **D-O9 - 整机级自动化并发上限**？ ➡️ v1 不做，只做 profile 级子池（默认 2）；v2 在 supervisor 进程内加整机信号量。

❓ **D-O10 - 跨主机看板**？ ➡️ v1 用 P2 兜底，并在卡片上注明；跨主机是刚需时再立项做 P3。

❓ **D-O11 - 一次性定时**？ ➡️ 支持，成本低，提醒类场景常用。

❓ **D-O12 - 同一 cwd 并发写**？ ➡️ v1 只在描述里提示风险，不做独占。

## 10. 未验证项清单（全部进入 A0）

1. lark-cli 用户 token 的存放位置：配置目录还是 OS keychain；改用独立的 `LARKSUITE_CLI_CONFIG_DIR` 能否让 token 不可见。
2. 卡片和 CardKit 实体是否只能由发送或创建它的 app 更新；14 天更新期限。
3. pin API、所需 scope、取消他人 pin 的权限；"群置顶"的权限设置。
4. 普通群"回复话题"的消息是否带 `thread_id`；不带 `replyTo` 发到 topic 群是否新建话题。
5. 消息事件里是否带 union_id；`NormalizedMessage` 或 raw event 能否取到。
6. 线上各 bot app 的实际 scope：群消息读取、建群、成员写入、通讯录、人事相关。
7. `WorkspaceStore.cwdFor('chatId:threadId')` 是否回落到 chat 级映射。
8. F20 的 `meeting:` scope 在线上是否已经让 backfill 出现 `mode-resolve-failed` 或 incomplete。
9. 线上多个 profile 是否共用同一个数据根。

## 11. 修订后的 ticket 拆分

和 RR spec 的关系：自动化系列放在 RR 的 **ticket 2（RunOutcome）之后**开始；A7 依赖 RR 的 4 和 3；端到端验证使用 RR 0b 的 test bridge。**在 A4（身份）合并之前，任何线上 profile 都不得开启 `automations.enabled`。**

| # | Ticket | 内容 | Blocked by | 开关 |
|---|---|---|---|---|
| A0 | Spike（不写产品代码） | 回答第 10 节的 1–9，结论写进 delivery note，脱敏 | — | — |
| A1 | 领域与存储 | `automations.json` v1；时间表解析和下次触发计算（工作日、时区）；限额；`createdBy`、`confirmedBy`、union_id；`isCreator` 重命名为 `isBotOwner`。纯函数加单测 | — | 无行为变化 |
| A2 | 调度器 | 归 `ManagedProfile` 所有并注入 `startChannel`；抖动、宽限和合并补跑、重叠跳过、`reconnect-in-progress` 重试；持久化 `lastFireAt`/`nextFireAt`；`fire()` 通过注入提供 | A1 | `automations.enabled`，默认关 |
| A3 | 自动化 run 路径 | `source:'automation'`（`ScopeContext`、fingerprint、`BridgePromptSource`）；scope `auto:<id>`；每次 fire 新 session；cwd 快照；子池加 `nowait` 重试；只发最终答案的结果消息（无表情、无 CoT、无流式）；topic 群处理；backfill 只接受 `oc_` 开头的 scope（顺带修 meeting）；记录 usage | A2，RR 2 | 同上 |
| A4 | 自动化身份与策略 | `AgentRunOptions` 增加逐 run 的身份和提示词变体，改 6 个 adapter；创建 `lark-cli-automation` 配置目录；自动化提示词；`tool_use` 守卫；审计日志 | A0，A3 | 同上；**上线门槛** |
| A5 | 创建与管理 | `/auto`（`\|` 语法）；`<automation_proposal>` 提取和删除；确定性描述渲染；draft 存储；新令牌类型的确认卡；创建者校验；孤儿暂停 | A1，A3（可以和 A4 并行开发） | 同上 |
| A6 | 续聊 | `resultMessageId → fire` 映射；话题 scope 首次接触时预置 session、catalog、workspace；覆盖 Codex catalog fingerprint 和 Claude cwd 的测试 | A3，A0 第 4、7 项 | 同上 |
| A7 | 失败通知与恢复 | 按 4.5 节的表实现；连续 3 次失败自动暂停；auth/quota 私聊 owner；turn journal 的 `kind:'automation'`、未送达重发、孤儿检测 | A3，RR 2/4/3 | 同上 |
| A8 | 群看板 | 共享注册表、租约选举、渲染和 pin、接管、13 天重发；为不在注册表里的 bot 做 P2 兜底 | A0 第 2、3、5 项，A2 | `automations.board`，默认关 |

建议顺序：**A0 → A1 → A2 → A3 → A4 → A5 → A6 → A7**，A8 在 A2 之后并行。每张票先写失败回归，再实现，在 feat worktree 里执行 `pnpm ci:local`（AGENTS.md）。
