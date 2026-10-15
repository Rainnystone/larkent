# Spec: Run reliability（丢消息修复、run outcome、turn journal、中断通知、test bridge）

Status: ready-for-agent（docs track）。Grill 已完成（Opus 5.5 high 评审，2026-10-15）；第 6 节的产品决策已由用户批准，不再重新 Grill。
Written 2026-10-15，基线 `master@ee7d60c`。文中行号以该提交为准；live 工作树另有未提交改动（`src/bot/channel.ts`、`src/bot/keepalive.ts`），实现前见第 8 节前置条件。

本文是目的地。`.scratch/run-reliability/issues/` 下的 ticket 是一次性的执行切片。实现者在 docs draft PR 上认领 ticket，产品代码只推到独立的 feat PR。

---

## 1. Problem Statement

2026-10-15（UTC+8）profile `cursor-claude`（Cursor CLI）在 11:07、11:51、12:36、13:49 四次以 `RetriableError: Connection stalled repeatedly`（exit 1）失败，运行时长 41–92 分钟；疑似平台出口隧道问题。故障期间用户发的一条“继续”丢失，用户也没有得到“run 被中断”的明确提示。

调查（只读）发现的根因分三类：

1. **消息丢失**：`recordAccepted` 在入队时就写 processed ledger（`src/bot/channel.ts:896-908`），`disconnect()` 调 `pending.cancelAll()`（`:609-610`），backfill 跳过已在 ledger 的消息，于是这条消息永远回不来。同类路径还有：任意命令清空 pending（`:895-900`）、`reconnect-in-progress` 拒绝批次却承诺“稍后处理”（`src/bot/run-flow.ts:155-158`）、`ManagedProfile.reconnect` 先连新后断旧的重叠窗口（`src/runtime/supervisor.ts:289-300`，旧 bridge `closing` 时直接丢事件 `channel.ts:421-423`）、重连间隔短时整段跳过 backfill（`src/bot/backfill.ts:128`，日志 `backfill.skip-short-gap`，三个 profile 合计约 887 次）、免 @ 群未 @ 消息补不回（`backfill.ts:413`）、`maxMentionsPerChat` 截断的旧消息被直接记成已处理（`:331-335`）。
2. **结束原因混用**：`RunHandle.interrupted` 是布尔值，把用户 `/stop`、supersede、`/reconnect`、keepalive restart、SIGTERM、bridge idle watchdog（`channel.ts:1742-1746`）、`ownedRun.stop()`（`src/runtime/run-executor.ts:199-201`）全混在一起；置 true 后非 system 事件被丢弃（`channel.ts:1762`），真实错误不可见；runner `timeout` 在卡片上渲染成 `idle_timeout`（`src/card/run-state.ts:143-149`）。agy 的 `[agy] print timeout … returning partial output` 以 exit 0 结束被当成 normal（`src/agent/antigravity/jsonl.ts:149-162`）；agy `error: interrupted` 多半来自进程组信号却记成 failed。stderr 只在非 0 退出时拼进错误并截断到 500 字符（`src/agent/runner/jsonl-cli-runner.ts:492-497`），`stderrChunks` 无界增长，原始 stderr 以 `errorMsg` 显示在卡片上，可能泄露路径或账号。
3. **没有可恢复的记录**：run 结束后没有持久记录，restart 后无法补发通知；“成功跑完但最终回复没送达”和“bridge 被 SIGKILL 后孤儿子进程继续运行”都无人处理。现有卡片 callback 鉴权要求 run 仍活着（`src/card/dispatcher.ts:213-228`），`activePolicyFingerprints` 只在内存。

另外，测试本身不安全：personal 模式下 owner/admin 先于 `allowedChats` 放行（`src/policy/access.ts:47-58`），文档评论 @bot 不过 access（`src/bot/comments.ts:208`），app 锁按数据根划分（`src/config/app-paths.ts:47-80`），两个数据根误配同一个 app id 会静默分流事件。

CLI 与 bridge 异常终止特征的证据见附录 A。

## 2. Goals / Non-goals

Goals：
- 每条被接收的用户消息恰好对应一个终态：回复、中断通知或显式确认。
- 每个 run 的结束都有一个统一、可测试的 **run outcome**，卡片终态、通知决策、日志都由它派生。
- 中断后用户能一键“继续”，而 bot 绝不自动续跑。
- 在专用、隔离的 **test bridge** 上先验证，再逐个切换 live bridge。

Non-goals（out of scope）：
- keepalive 重连会杀掉进行中 run（keepalive-reconnect-kills-runs），另开项目。
- 探测 CLI 后台任务（background job probe），评审认为不可行。
- 改 CLI 本身、改模型出口/隧道。
- 判断模型或出口是否恢复：bridge 只知道飞书可达与否。

## 3. Vocabulary（同步加入 CONTEXT.md）

- **stop reason**（`stopRequest`）：bridge 请求停止 run 的原因，在调用点设置、先写者胜。不同于 runner 内部的 `stopReason`（“怎么停的”）。
- **run outcome**（`RunOutcome`）：由 stop reason、退出码/信号、终态事件、stderr 尾部和 adapter 签名表派生的唯一结束分类。
- **turn journal**：每个 profile 独立文件，记录一次用户 turn 从入队到回复送达/通知送达的状态，用于重启恢复。不是 processed ledger。
- **interruption notice**：run 以 `interrupted` 或可重试的 `failed`/`partial` 结束后，bridge 发出的一条新消息（卡片），@ 发起人并提供「继续 / 暂不」。
- **test bridge**：`e2e/test-bridge/` 驱动的隔离 bridge 实例，独立数据根、独立 app、硬 access 围栏，默认 fake CLI。

## 4. Locked decisions

D1. 顺序固定：**0a → 0b → 1 → 2 → 5 → 4 → 3**。每个 ticket 独立可合并；改变行为的部分用开关控制。
D2. processed ledger 保持 `schemaVersion: 1`，只追加字段（loader 严格校验版本，`src/bot/backfill-ledger.ts:259-261`）。turn journal 用单独文件；旧代码回滚时忽略它。
D3. 生产代码不加 test hook。故障只从三个外部入口注入：`agent.binaryPath` 指向 shim、代理环境变量、信号。0a 是唯一为测试动的生产代码，而且它对 live 同样有用。
D4. test bridge 默认 fake CLI；透传真实 CLI 必须显式开关（用户决定）。
D5. “继续”语义：用同一 resume handle 继续，注入一次性提示“上一轮在哪里、因为什么被中断，请先核对已完成的步骤，避免重复执行有副作用的操作”；**不重放原 prompt**。只有中断发生在拿到 resume handle 之前时，才退回重跑原批次。
D6. 该 chat 中任何被允许使用 bot 的用户都可以按「继续」，不限 initiator。
D7. 通知是新消息，@ 发起人；文案写“或 @bot 继续”（在需要 @ 的群里必须带 @）；话题群用 `replyInThread`。
D8. 通知按钮是新的签名 action，绑定 `turnId` + journal 中的 policy fingerprint，nonce 一次性，带 TTL，session 切换后失效。
D9. 每个 session/scope 连续通知最多 3 次，普通用户消息重置计数；第 4 次降级为纯文本，不带按钮。
D10. auth-invalid：不给“继续”；在 chat 内告诉 initiator 一次，并私聊 owner 一次，去重；**不暂停**新 run。
D11. 通知投递是 journal 里的待发项，重启后限流发送。
D12. 通知卡开关默认关，按 profile 开启。
D13. `/new` 与任何 session 切换都作废旧 session 里未完成的 journal 记录。

## 5. Tickets

Ticket 文件在 `.scratch/run-reliability/issues/`，每个都带测试计划。摘要：

| # | Ticket | Blocked by | Flag |
|---|---|---|---|
| 0a | 统一硬 access 围栏 + 机器级 app 锁 + live 根防护（生产代码） | — | `access.fence` per profile，默认关 |
| 0b | repo 内隔离 test bridge `e2e/test-bridge/` + 确定性 vitest 层 + 首个重投实验 | 0a | 不进 npm 包 |
| 1 | 丢消息修复（全部路径） | 0b（实验结论决定 short-gap 策略） | 默认开（修 bug），短 gap 补扫可开关 |
| 2 | RunOutcome 模型 + stop reason 枚举 | 1 | 无用户可见改变（日志与卡片映射） |
| 5 | per-adapter CLI 签名表 + golden stderr 夹具 + 脱敏文案 + 有界 stderr | 2 | 脱敏文案可开关 |
| 4 | turn journal（未送达重发、孤儿检测、session 切换作废） | 2, 5 | `journal.enabled`，默认开写、恢复动作可关 |
| 3 | interruption notice 卡片 | 4 | `notice.enabled` per profile，默认关 |

### 5.1 Ticket 0a：硬 access 围栏与锁
- profile 级 `access.fence`（名字由实现者定）：启用时，DM、群、会议、卡片点击检查 chat 在 `allowedChats` **且** 发送者在 `allowedUsers`；owner、admin 不豁免；未启用时行为不变。
- **评论入口例外（已实现、与上条不完全相同）**：文档评论只检查发送者 ∈ `allowedUsers`，不要求 chat ∈ `allowedChats`。评论事件没有与 IM 会话同构的 chat id；用 `fileToken` 冒充 chat 会误伤或误放。单位测试见 `tests/unit/comments/comment-access-fence.test.ts`。
- 机器级 app 锁：放在与数据根无关的位置（如 `$XDG_RUNTIME_DIR` 或 `~/.cache/larkent/locks/app/<hash(appId)>`，不在路径里写明文 app id），两个数据根用同一 app id 时第二个拒绝启动并给出清晰错误。
- live 根防护：实例声明为 test（配置或环境变量）时，若解析出的数据根等于默认 live 根或已被 live 实例持有，拒绝启动。

### 5.2 Ticket 0b：test bridge
- 位置 `e2e/test-bridge/`，Node/TS，命令 `pnpm e2e:up|down|fault|send|read|scenario`；只支持 POSIX；不进 `package.json` 的 `files`，不放 `scripts/`（已 gitignore），不做 CLI 子命令。
- 入库：`e2e/test-bridge.example.json`（只有占位符）、shim、故障代理、driver、场景、README。不入库：`e2e/.local/`（加进 `.gitignore`），放 app id、chat id、open id、tester 配置目录路径。
- 数据根固定在 `~/.lark-channel-e2e/<instance>` 一类位置，配合 0a 的 live 根防护。tester 用户 token 放在**独立配置目录**，在 test 数据根之外，scope 只给目标群的发和读。
- shim：透传用 `exec`；故障模式用 `trap` 转发信号；`--version`/`--help` 透传；故障按 run 一次性生效并带 runId 过滤，可选 sticky。cursor-auth 只能 shim 模拟，不得执行真实 logout。
- 故障代理：只给 test bridge 设 `HTTPS_PROXY`（channel 已 `respectProxyEnv: true`，`channel.ts:292`），按 host 区分飞书/模型出口，模式 disconnect、blackhole（半开）、TLS `EPROTO`、`EAI_AGAIN`、slow。记录副作用：keepalive `httpProbe` 用 Node `fetch` 默认不走代理，会出现“代理断了但判可达”，作为一个场景保留。
- 信号：`kill-cli` 两个变体，只杀子进程；向进程组发信号（模拟 supervise.sh/Ctrl-C）。SIGSTOP 冻结只用于 wake-up 分支，不当作 ws-stuck。
- 默认 fake CLI；真实 CLI 透传需显式 flag。
- 确定性层：用 `tests/helpers/recording-lark-channel.ts`、`scripted-jsonl-cli.ts`、`fake-executable.ts` 写 vitest，CI 可跑。真飞书层只回答真实环境才能回答的问题。
- 断言基于结构化日志（`card.final`、`run.failed`、`backfill.*`），飞书读回作补充。核心不变量：每条被接收的 tester 消息恰好一个终态。
- **首个实验**：断开 20–30 秒期间发出的 @ 消息，飞书是否经 WS 重投？结论写进 delivery note，决定 ticket 1 的 short-gap 策略。
- **追加实验**：`host-sleep-cli-self-send` — 主机睡眠/重连中途 CLI 自发送达。恢复后同一 turn 不得出现第二条终态回复。

### 5.3 Ticket 1：丢消息
- 新增 `ledger.unrecord(messageId)`；`disconnect()` / `cancelAll` 时把未开始的 pending 撤销记录，并 `ledger.markScanIncomplete(最早 createTime)`。现有逻辑在 `incompleteFrom` 有值时绕过 short-gap 跳过，下一次恢复信号必然补扫。
- short-gap：按 0b 实验结论，若飞书不重投，则有被丢弃 pending 时强制补扫（上一条已覆盖），否则保持跳过；无论如何不得出现“已记 ledger 却未处理”。
- 命令只清空语义上应取消的队列（`/stop`、`/new` 等 session 切换）；只读命令（`/status`、`/doctor`、`/ps` 等）不清空 pending。被清空的消息要么撤销记录，要么给出显式确认。
- `reconnect-in-progress` 被拒：不记 ledger（或撤销），重新入队或 `markScanIncomplete`；修正用户可见文案以免承诺兑现不了。
- restart 重叠窗口：旧 bridge 断开后显式移交 pending 给新 bridge，或在交接完成后再触发一次 backfill；旧 bridge `closing` 期间收到的事件不得静默丢失。
- 免 @ 群与截断：截断掉的消息不记成已处理（改为 `markScanIncomplete` 或记录截断日志并保持可补）；免 @ 群的 backfill 过滤与 live 规则一致。
- 同步修改 CONTEXT.md 中 **claim** 的定义。

### 5.4 Ticket 2：RunOutcome 模型
- `stopRequest` 枚举（调用点设置，先写者胜）：`user-stop`、`superseded(new|cd|ws|resume)`、`reconnect-command`、`keepalive-restart`、`account-restart`、`shutdown-signal`、`exit-command`、`bridge-idle-watchdog`、`runner-timeout`、`meeting`、`subscriber-abandoned`、`external-signal`（无 stop 请求但信号退出或匹配 stderr 特征）。
- `RunOutcome` 类别：`completed | partial | interrupted(reason) | failed(transient-upstream | auth-required | quota | killed-externally | unclassified)`，附 `retriable`、`needsHuman`。
- 卡片终态、通知决策、指标都从同一个值派生；switch 用 `never` 穷尽检查。`interrupted` 置位后不再丢弃真实终态事件；同时出现真实终态和 stop 请求时，真实终态胜出。
- runner `timeout` 与 bridge idle watchdog 在卡片和日志中区分。
- 决定是否让子进程使用独立进程组（`detached`），记录取舍（组信号不误伤 vs. bridge 被 SIGKILL 留孤儿，孤儿由 ticket 4 处理）。
- `card.final` 日志带 `stopReason`、`outcome`。

### 5.5 Ticket 5：CLI 签名表
- 签名表放在各 adapter 的 descriptor，由一处共享代码应用；每条带 CLI 版本、golden stderr 夹具（`tests/fixtures/goldens`）、分类、脱敏后的用户文案。
- 在**退出 0 时**也匹配完整 stderr（agy partial output → `partial`）。
- stderr 缓冲有界（例如保留头尾各 N KB），匹配用该缓冲，不再用截断后的 500 字符。
- 卡片上不再直接展示原始 stderr；显示签名表的脱敏文案，原文只进本地日志。
- grok、kimi 条目标注“仅合成验证，未在真实日志中见过”。未知错误归 `unclassified` 并计数。

### 5.6 Ticket 4：turn journal
- 单独文件（如 `turn-journal.json`，每 profile），自带 `schemaVersion: 1`，原子写；旧代码忽略。
- 字段：`turnId`、scope、chat/thread、messageIds、发送者、initiator、开始时 resumeHandle、policy fingerprint、子进程 pid 与启动时间、状态、outcome、通知状态、连续中断计数。
- 状态：`queued → running → settled → reply-delivered`，另有 `completed-undelivered`（在下一恢复信号重发）、`interrupted`、`notice-pending → notice-delivered`、`voided`。
- 启动时孤儿检测：按 pid + 启动时间判断子进程仍在，则先 kill 或等待，再决定是否通知，避免“通知中断”与“孤儿完成回复”同时出现。
- `/new` 与任何 session 切换（`supersedeSession` 的全部调用点）把旧 session 的未完成记录置 `voided`。
- 有界保留（按时间/条数清理）。

### 5.7 Ticket 3：interruption notice
- 按第 4 节 D5–D13 实现。触发条件：outcome 为 `interrupted`（非 `user-stop`、非 session 切换）或 `retriable` 的 `failed`/`partial`。`needsHuman`（auth-required）走 D10 分支。
- 实现“继续”：按钮与“@bot 继续”文本都合成同一个继续请求；该 scope 的下一条普通消息同样带一次性中断提示。
- 新 action 校验：签名、turnId、journal 中的 fingerprint 与当前一致、nonce 未用、未过 TTL、无 session 切换、点击者通过该 chat 的 access（含 0a 围栏）。
- 发送失败留在 journal 待发；重启后限流。

## 6. 测试策略

- 每个 ticket 先写失败回归（红），再实现（绿），在 feat worktree 执行 `pnpm ci:local`。
- 确定性层（vitest）覆盖故障矩阵；test bridge 每个 ticket 至少复现一次真实场景，证据写进 delivery note（脱敏，不含 ID）。
- 端到端不变量：每条被接收的 tester 消息恰好一个终态（回复、通知或显式确认），无重复回复。

## 7. 开关与回滚

- 每个改变行为的 ticket 带 profile 级开关；通知卡默认关。
- ledger 保持 v1；journal 是新文件。回滚到旧代码时忽略 journal、ledger 新字段，正常运行。

## 8. Rollout

前置条件（**由用户/Coder 完成，不在本 spec 的 PR 里做**）：
- 把 live 工作树（`~/src/larkent`）里 `src/bot/channel.ts`、`src/bot/keepalive.ts` 的未提交改动整理成 commit/分支并合入（或至少推成分支），作为所有 ticket 的基线。否则合并会冲突，或在部署时把这些改动静默覆盖。

流程：
1. **空闲判据**：在 `/status` 或 `/doctor` 输出里加一项 idle（`activeRuns`、`pending`、backfill in-flight 均为空）。切换 live 本身就是一次 SIGTERM 中断，只在 idle 时切。（可随 ticket 1 或 0a 一起交付。）
2. 每个 ticket 单独合并到 master，先在 test bridge 上验证。
3. 逐个切换 bridge（一次一个），观察日志后再切下一个；出问题按上一个 SHA 回滚并恢复对应数据备份（见 CONTEXT.md “A code rollback does not downgrade data”）。
4. 部署由 Coder 执行。通知卡按 profile 逐个开启。

## 9. Open items

- **“每周一 /new”**：验收方提到的每周 /new 在本 repo `src` 中找不到实现，待确认它由谁触发。只有经 `/new` 命令进入时才被 `supersedeSession` 路径覆盖（D13）。
- e2e-tester 是否为 Test Bot 的 owner/admin（0a 围栏启用后不再影响隔离，但影响测试覆盖）。
- 测试群是普通群还是话题群；话题群、普通群、私聊三种都需覆盖。
- supervise.sh 发信号给进程组还是 pid；是否有 systemd/launchd。
- 是否有确证在 19–27 秒短断开期间丢失的 `message_id`（0b 实验回答）。
- Test Bot 是否订阅文档评论与 vc 事件；scope 与 live 对齐还是最小权限（建议 check-scopes 对比 test 与 live 差异）。
- 批次有多个发送人时 initiator 的定义（建议：触发 run 的最后一条消息发送者），由 ticket 3 实现者在 delivery note 中写明。

## 附录 A：异常终止特征（2026-09-07 至 2026-10-15 bridge 日志，UTC+8）

| CLI | stderr 特征 | exit | 现有分类 | 次数 | 期望 outcome |
|---|---|---|---|---|---|
| Cursor | `RetriableError: Connection stalled repeatedly` | 1 | run failed | 4 | `failed(transient-upstream)`, retriable |
| Cursor | `Your stored authentication is invalid… run 'agent login'` | 1 | run failed | 2 | `failed(auth-required)`, needsHuman |
| Cursor | keepalive `agent-version-check-timeout` | – | force-reconnect 失败 | 5 | 环境，非 run outcome |
| agy | `error: interrupted` | 1 | run failed | 1 | `interrupted(external-signal)` |
| agy | `[agy] print timeout after 5m0s with turn in progress; returning partial output` | 0 | normal | 3 | `partial`, retriable |
| agy | `root agent idle; waiting for N background task(s)` | – | stderr 警告 | 2 | 仅日志 |
| agy | `post-done-exit-timeout` | – | 完成后未及时退出 | 3 | `completed` |
| Grok | 无 | – | – | 0 | 缺口，仅合成 |
| Kimi | 无 profile | – | – | 0 | 缺口，仅合成 |

bridge 侧事件（三个 profile 合计）：keepalive ws-stuck ≈923、ws reconnecting/reconnected ≈959/951、force-reconnect 24、backfill skip-short-gap ≈887、backfill incomplete ≈131、sdk error ≈688（timeout / `EAI_AGAIN` / `EPROTO` / socket hang up / HTTP 400）、unreachable/reachable-again 98/37。
