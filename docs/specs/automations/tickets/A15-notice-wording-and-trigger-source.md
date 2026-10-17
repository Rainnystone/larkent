# A15 — 通知措辞与日志来源：跨日期的已错过/补跑、triggerSource、中断类通知不带追问页脚

Status: ready-for-agent
Severity: minor（A11 发现的 UX / 审计准确性问题，不阻塞上线，但三项都会误导读者）
Blocked by: A14（页脚改动和 A14 动同一处 `agent-run.ts`，先合 A14）
Track: 推到现有 code 分支 `feat/automations-v2`（PR #49），不开新 PR
Spec: [../../automations.md](../../automations.md) §5（结果帖与追问）、§10 Observability（`auto.catch-up` 触发来源）、ADR-016/017/019/021

## (a) 不在今天的已错过/补跑时刻要带日期

**现象（A11）**：04:28 重启后 id11（一次性，原定 **2026-10-17** 03:08，错过 >24 h）发出 om_…7219「已错过：A11-R4超24h 原定 03:08」——读者会以为是今天 03:08。

**根因**：`formatScheduledHm`（`src/automations/delivery.ts:98`）只输出 `HH:MM`；`formatMissedNoticeText`（:44）、`formatReminderText` 的「补跑，原定」（:38-42）、agent 结果帖的「补跑，原定」（`src/automations/agent-run.ts:87`）和补跑 prompt 提示（agent-run.ts:57）都用它。补跑上限 24 h，跨午夜（原定 23:50、00:10 补跑）同样会产生歧义；已错过可以早于 24 h。看板（`board-card.ts`）已用 `formatZonedDateTime` 带完整日期，不受影响。

**要做**：一个格式函数 `formatScheduledLabel(timeZone, fireAt, now)`：原定时刻在**发帖时刻的同一本地日期**（按任务时区）→ `HH:MM`；否则 → `MM-DD HH:MM`；不同年份 → `YYYY-MM-DD HH:MM`。上述四处全部改用它（`now` 用调度器注入的时钟）。spec 里「补跑，原定 HH:MM」的示例同步改为说明跨日带日期。

**验收**
- [ ] 单测：同日 → `原定 03:08`；昨日 → `原定 10-17 03:08`；跨年 → `原定 2025-12-31 23:50`；时区边界（任务时区与 UTC 日期不同）按任务时区判断。
- [ ] 单测：已错过通知、reminder 补跑、agent 结果帖补跑、补跑 prompt 四处都走同一函数（任何一处跨日都带日期）。

## (b) automations log 的 `triggerSource` 要如实

**现象（A11）**：id9 在**定时器**唤醒时被重叠跳过（03:57:18、04:07:18），automations log 记 `triggerSource:"startup"`（`automations.log` 第 2、3 行）。另外 04:28:51 冷启动后的已错过/补跑全部记成 `link-recovered`，没有一条 `startup`。

**根因（已在 a27e564 只读核对）**
- `handleDue()`（`src/automations/scheduler.ts:537`）没有来源参数，内部写死 `'startup'`：`skipUnsettledAgentSlots(item,'startup')`（:543、:552）、`applyCatchUp(live,'startup')`（:559）、`fireExact(..., 'startup', ...)`（:562）。它被 `start()`（:131-138）、`onLinkRecovered()`（:153-159）和定时器回调（:618）共用，所以**定时器唤醒和 link 恢复后的到期处理都被记为 startup**——不只是 skip，定时器唤醒后在宽限外走 `applyCatchUp` 的补跑也一样。
- `AutomationTriggerSource = 'startup' | 'link-recovered' | 'wake'`（`src/automations/store.ts:17`），没有定时器这一项；读回校验（store.ts:981-987）也只认这三个。
- 冷启动被记成 link-recovered：FeishuLink 启动时处于 down，首次连上走 `goUp → emitRecovered`（`src/bot/feishu-link.ts:181-223`）；channel 在 `started.onRecovered`（`src/bot/channel.ts:906`）里排队 `scheduler.onLinkRecovered()`，这一订阅早于 `automationsScheduler.start()`（channel.ts:1130），且调度器是串行队列，所以 `catchUp('link-recovered')` 先跑、把已错过/补跑都记掉，随后 `start()` 的 `catchUp('startup')` 已无事可做。（实现者先写测试确认这一时序；A11 证据：04:28:54 起的 missed/catch-up 全是 link-recovered。）

**要做**
- 类型加 `'timer'`；`handleDue(source)` 由调用方传入：`start()`→`startup`、`onLinkRecovered()`→`link-recovered`、定时器回调→`timer`；`store.ts` 读回校验同步接受 `timer`。
- 冷启动：进程启动后的第一次 link 恢复（scheduler 尚未 `start()` 完成之前）记为 `startup`，不是 `link-recovered`；之后的掉线恢复照旧 `link-recovered`。实现方式实现者定（例如 scheduler 在 `start()` 完成前收到的 `onLinkRecovered` 并入 startup，或 channel 在调度器 start 之后才订阅），但不能丢掉启动时那一次 catch-up。
- spec §10 的触发来源列表加 `timer`。

**验收**
- [ ] 单测（假时钟）：agent 任务上一次未结算，定时器唤醒到点 → automations log `skipped` 条目 `triggerSource:'timer'`。
- [ ] 单测：定时器唤醒晚于宽限（模拟睡眠）→ `catch-up` 条目 `triggerSource:'timer'`。
- [ ] 单测：冷启动且 link 首次连上发生在 `start()` 之前/之后两种顺序 → 停机期间的 `missed`/`catch-up` 都记 `startup`；运行中掉线再恢复 → `link-recovered`；wake CLI → `wake`。
- [ ] 旧日志文件（只有三种来源）照常读回；新 `timer` 条目可读回。

## (c) 策略拦截和中断类通知不带「在本消息话题里追问」

**现象（A11）**：id5 策略拦截通知 om_…e0af「自动化任务中断：策略拦截 / 在本消息话题里追问」；id9 进程退出中断通知 om_…81de 同样带这句页脚。

**在这些通知下面追问实际会发生什么（a27e564 只读核对）**
- 页脚由 `formatAgentResultPost`（`agent-run.ts:79-91`）无条件追加；失败/中断正文 `formatAgentFailureBody` 也走它（agent-run.ts:93-109，:286-288），启动时回收中断 fire 的通知也走 `formatAgentFailureNotice`（`src/bot/channel.ts:644-660`）。
- 这些通知和正常结果帖一样以 `reply.messageId` 记在 journal 的 `auto:<id>:<fireAt>` scope 上，`automationScopeForReply`（agent-run.ts:111-126）不区分 outcome，所以话题回复会被路由到该 fire 的 scope（`channel.ts:1370`），走**人类路径**；该 scope 的会话在 fire 开始时（`system` 事件，`recordRunSessionEvent`，agent-run.ts:243-252）就已记下，所以回复会**续接被中断的那个会话**。
- 人类路径不带自动化 run 的约束：A9 的仅 bot 身份和 `policy-guard` 检查只在 `drainFireRun`（agent-run.ts:391）里；追问用的是回复者在本群的普通权限。
- 结论：
  - 策略拦截后追问 = 在去掉守卫的情况下续接刚被拦下的会话，一句「继续」就能让它把被拦的事做完。这不是有意义的追问，而是绕过守卫的入口。
  - 进程退出 / 超时 / 运行失败后追问 = 手动「继续」一个半途的 fire。spec 明确 automations 不提供继续、不续跑（spec 开头「永不使用 Continuations」，§4 `auto:` scope 不进入继续通知流程）；而且 agent 并不知道自己被中断，问「发生了什么」也答不出来。
  - 正常完成（含 partial）的结果帖：追问有意义，A11 04:03 已验证（om_…5922），保持不变。

**要做**
- 页脚只加在 outcome 为 `completed`/`partial` 的结果帖上；`interrupted`（含 `policy-guard`、`shutdown-signal`、超时）、`failed`、缺 cwd、`startRunFlow` 被拒这些通知都不加页脚。补跑标注照旧保留。
- 这些通知**不作为追问锚点**：`automationScopeForReply` 跳过 outcome 为 interrupted/failed 的 journal 条目（或在 stage 时给 reply 打 notice-only 标记，实现者选一种）。在它们下面回复，按普通群/话题群规则进入群 scope，不续接被中断的会话。
- 策略拦截通知改为说明下一步：`自动化任务中断：策略拦截（<原因>）。任务已暂停，可在看板恢复或删除。`（原因用现有 `PolicyGuardReason` 的中文标签，不含任务正文）。

**验收**
- [ ] 单测：policy-guard、shutdown-signal、idle-timeout、failed、缺 cwd 五种通知正文都不含「在本消息话题里追问」；completed/partial 结果帖仍含。
- [ ] 单测：在 policy-guard 通知下的话题回复，scope 解析为群 scope（普通群）/ `chatId:threadId`（话题群），**不是** `auto:<id>:<fireAt>`，不 resume 该 fire 的会话；在正常结果帖下的回复仍解析为 `auto:` scope 并续接（A8 现有测试保持绿）。
- [ ] 单测：重启回收的中断 fire 通知同样无页脚、非锚点。

## 共同验收
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。
- [ ] spec 同步：跨日带日期、`timer` 触发来源、中断类通知无追问页脚且不续接。

## A11 需重跑的场景
停机跨两次 fire 后重启（已错过 + 补跑；含一个前一天的一次性任务 → 通知带日期；log 记 `startup`）；运行中断开 link 再恢复（log 记 `link-recovered`）；A12 重叠跳过（log 记 `timer`）；A9 策略拦截（通知无页脚；在其话题里回复不续接被拦会话）；fire 运行中停 bridge（中断通知无页脚、无继续）；A8 正常结果帖话题追问仍续接。
