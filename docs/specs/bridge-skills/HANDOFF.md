# PR51 — Bridge plugins 与 automation 规格交接

Revision 3 · 2026-10-20 · Status: P09 E2E 已完成，P09 修复 8/13 完成，剩余 P09e/f/g/j/m 交 Codex 实施（见下方“当前状态（2026-10-20）”）

## 从这里开始

1. 读 [Revision 3 规格](../bridge-skills.md)：产品边界、User Stories、模块契约与验收。
2. 本文件提供代码导航和旧方案差异；实现时重新核对 checkout 与当前代码。
3. [B01–B07](tickets/README.md) 全部是 superseded 的旧票，不能认领或照旧执行。
4. [P01–P09](tickets/README.md) 是当前实施票；连同共同契约、各票正文和本导航读取。拆票已完成，代码实施尚未授权。

文档载体：[PR #51](https://github.com/Rainnystone/larkent/pull/51)，分支 `docs/bridge-skills`；保留文档专用、不合并的既有约定。用户已明确授权修订该 PR，并委托按工程判断继续 to-tickets。测试 seam 已在讨论中确认。

## 当前状态（2026-10-20，接手先读）

> 本节覆盖下文旧的“尚未授权实施”表述；下文代码导航仍可参考。时间为 UTC+8。剩余票改由 Codex 实施，本节应足以冷启动接手。

- **代码：** PR #52（分支 `feat/bridge-skills`）。最后一次经 Codex 审阅的 head 为 `0b55865`（P09 验收候选）；当前 head `d24d781`（更新本节时 CI：ubuntu、macOS 已通过，Windows 与第二轮 macOS 仍在运行；接手先跑 `gh pr checks 52`）。
- **P09 真实飞书 E2E：** 已完成一轮（Grok Build、Antigravity、Cursor CLI、Kimi），问题拆为 P09a–P09m，索引见 [tickets/README.md](tickets/README.md)。

### 已完成（`0b55865..d24d781`）

| 票 | 提交 |
| --- | --- |
| P09a | `6ea64b9` fix + `b42504f` refactor（确认卡精确剩余次数） |
| P09b | `d661277`（backfill 保留真人 sender_type） |
| P09c | `3930464`（用 user_card_content 回读绑定丢失的草稿卡） |
| P09d | `d24d781`（bridge 工具调用折叠为友好标签） |
| P09h | `672b5fa`（从未触发视为 never） |
| P09i | `7c24dc2`（结束日期卡增加一周/两周预设） |
| P09k | `3f2e11f`（缺失包根目录诊断为 missing-root） |
| P09l | `5b398a2`（Grok 工具结果字节数组按 UTF-8 解码） |
| 仅测试稳定性 | `b1d487d`、`dbfe84c`、`4fb6f92`、`17d086e`（以等待真实事件替代轮询/计时，修 Windows 5s 竞态） |

### 剩余（交给 Codex）

票文件均在 [`docs/specs/bridge-skills/tickets/`](tickets/)（本 docs 分支；代码分支上没有，也不要拷过去）：

| 票 | 文件 | 前置（均已完成） | 顺序 |
| --- | --- | --- | --- |
| P09e | [P09e-card-click-reply-race.md](tickets/P09e-card-click-reply-race.md) | G1：P09d ✅ | 先做 |
| P09f | [P09f-reply-protocol-fields.md](tickets/P09f-reply-protocol-fields.md) | G1：P09e | 必须在 P09e 之后 |
| P09g | [P09g-replace-card-copy.md](tickets/P09g-replace-card-copy.md) | G2：P09a ✅ | 独立 |
| P09j | [P09j-plugin-conflict-shadowing.md](tickets/P09j-plugin-conflict-shadowing.md) | G3：P09k ✅ | 独立（judgment：选择器需符合 D2/D3） |
| P09m | [P09m-policy-guard-help-false-positive.md](tickets/P09m-policy-guard-help-false-positive.md) | G4：P09h ✅ | 独立 |

即：P09e→P09f 串行；P09g、P09j、P09m 互不依赖，可任意顺序。

### 实施规则

- 只推已有分支 `feat/bridge-skills`；不开新 PR，不 force-push，不改写已推历史。
- 代码分支不放 `.scratch`、Spec 或票文件。
- 一票一个提交（消息注明票号，如 `fix(...): ... `，正文写 P09x），每个提交自带先失败后通过的测试（TDD）。
- 异步测试等待真实事件（promise、事件回调、flush），不数 tick、不靠 sleep/固定超时轮询。
- 本地 `pnpm ci:local` 通过；推送后 #52 CI 三平台必须全绿（不得重跑碰运气掩盖 flake，flake 要修）。
- 实施方不发 `@codex`、不请求 review、不改 PR 描述。
- 仓库公开：不写入飞书 ID、人名、chat/message ID、密钥或 token。
- 只允许普通合并（merge commit），禁止 squash/rebase 合并。

### 为什么要修（用户可见影响）

| 票 | 级别 | 影响 |
| --- | --- | --- |
| P09a | **done**（`6ea64b9, b42504f`） · P2 | 周期确认卡次数与实际不符 |
| P09b | **done**（`d661277`） · P2 | 重启/断线后补发的真人消息被判为非人工 |
| P09c | **done**（`3930464`） · P2 | 发卡结果未知时回读对账绑不上卡 |
| P09d | **done**（`d24d781, c832d21, 65f2c19, 982b01d`） · P3 | 工具卡暴露内部 bridge tool 命令与协议 JSON |
| P09e | **done**（`5f4385b, e31a84e`） · P3 | 最终回复发出前用户已点卡，回复仍写“待确认”，与卡片矛盾 |
| P09f | **done**（`c18b168`） · P3 | 回复原样搬运 `waiting-confirmation`、`applied` 等机器字段 |
| P09g | **done**（`b79a9fc`） · P3 | 替换卡正文“将删除：#N”让人以为任务会被删掉 |
| P09h | **done**（`672b5fa`） · P3 | 从未触发的任务显示“上次运行成功” |
| P09i | **done**（`7c24dc2`） · P3 | 结束日期卡最短预设一个月 |
| P09j | **done**（`14eb356, 5e266e3`） · P3 | 同名冲突包让合法包消失，歧义结果给出的 reference 也无法用来选择 |
| P09k | **done**（`3f2e11f`） · P3 | 插件目录不存在时只给未文档化的 `invalid-package` |
| P09l | **done**（`5b398a2`） · P3 | Grok 工具卡把输出显示成字节数组 |
| P09m | **done**（`0494223, d3425b7, 2daa863`） · P3 | 只读 `auth logout --help` 被误判为认证变更，任务被暂停；`auth-config` 码 agent 看不到 |
| P09o | **done**（`96cc1fd`） · P2 | Grok shell 退出码非 0 仍显示成功（见 [P09o](tickets/P09o-grok-shell-failure-renders-success.md)） |
| P09p | **done**（`0ccc762`） · P3 | 草稿修订后旧确认卡仍有效，点「是」重复建任务（见 [P09p](tickets/P09p-superseded-draft-card-still-live.md)） |
| P09q | **done**（`7188161, 6dd0e44`） · P3 | 多草稿状态回复泄漏 `applied` 字段与完整 ID（见 [P09q](tickets/P09q-multi-draft-reply-leaks-fields.md)） |
| P09r | **done**（`ce25d90`） · P3 | 工具卡出现 ANSI 颜色码，与 NO_COLOR 警告同修（见 [P09r](tickets/P09r-tool-card-ansi-escapes.md)） |
| P09s | **done**（`e4459f1`） · P2 | Grok shell 失败（exit 2）显示 ✅（见 [P09s](tickets/P09s-grok-statusless-update-as-result.md)） |
| P09t | **done**（`567fe36`） · P2 | 详细 CoT 出现 ANSI 颜色码（见 [P09t](tickets/P09t-grok-ansi-raw-string-bytes.md)） |
| P09u | **done**（`77c62b3`） · P2/P3 | Grok 每张工具卡带 NO_COLOR 警告（见 [P09u](tickets/P09u-grok-force-color-no-color-warning.md)） |
| P09v | **done**（`93a6c75, 9d38691`） · P2 | 修订后旧卡仍可确认，产生同名重复任务（见 [P09v](tickets/P09v-draft-revision-without-supersede.md)） |
| P09w | **done**（`5c9f145, 7b94bdc`） · P3 | 回复误称草稿在生成期间被外部取消（见 [P09w](tickets/P09w-same-turn-supersede-label.md)） |
| P09x | **done**（`8d06360`） · P3 | 回复次数与卡不符、出现状态码（见 [P09x](tickets/P09x-reply-count-and-status-codes.md)） |
| P09y | **done**（`6129cbf`） · P3 | 用户看不到确认成功，易重复操作（见 [P09y](tickets/P09y-confirm-success-without-feedback.md)） |
| P09z | P3 deferred | 无（风险记录）（见 [P09z](tickets/P09z-deferred-review-findings-1-3.md)） |
| P09aa | **done**（`4556ad8, 0b7009f, gate narrowed by 48874d4`） · P1 | 停止/空闲超时时 Grok 的暂存答案被丢弃（见 [P09aa](tickets/P09aa-grok-stop-drops-final-text.md)） |
| P09ab | **done**（`738e145`） · P1 | P09u 不完整：Grok 工具进程自设 NO_COLOR+FORCE_COLOR，Node 警告仍进工具卡（见 [P09ab](tickets/P09ab-grok-tool-env-node-color-warning.md)） |
| P09ac | **done**（`3dd6658`） · P2 | Profile 模型列表含不存在的 `grok-build`，错误被泛化（见 [P09ac](tickets/P09ac-grok-model-list-invalid.md)） |
| P09ad | **done**（`4aca859, f5e14c1, revised by b4cda3f (P09az)`） · P1 | Grok 及其 shell 继承 bridge 全部进程环境（含凭据类变量）（见 [P09ad](tickets/P09ad-grok-env-inherits-bridge-secrets.md)） |
| P09ae | **done**（`915c6f6`） · P2 | Profile 访问模式不映射到 grok argv（read-only 仍 --always-approve）（见 [P09ae](tickets/P09ae-grok-access-mode-ignored.md)） |
| P09af | **done**（`1c4114b`） · P2 | Grok `thought` 被丢弃：CoT 为空，idle 计时视为静默（见 [P09af](tickets/P09af-grok-thought-dropped.md)） |
| P09ag | **done**（`a2169ce`） · P2 | Grok 恢复失败/未知模型被归为通用可重试失败（见 [P09ag](tickets/P09ag-grok-failure-signatures.md)） |
| P09ah | **done**（`74f31ec, follow-up 8949a2d (P09bb)`） · P2 | 会议运行无 idle watchdog，挂起的 grok 无限期存活（见 [P09ah](tickets/P09ah-meeting-no-idle-watchdog.md)） |
| P09ai | P2 | 停止只信号 grok pid，孙进程（shell 工具）存活（见 [P09ai](tickets/P09ai-stop-leaves-grandchildren.md)） |
| P09aj | **done**（`abf36e5`） · P3 | 单行 JSONL 无大小上限地缓冲（见 [P09aj](tickets/P09aj-jsonl-line-unbounded.md)） |
| P09ak | **done**（`c4443bc`） · P3 | `read_file` 工具卡显示 JSON 原文；usage 事件发三次（见 [P09ak](tickets/P09ak-grok-readfile-blob-usage-dup.md)） |
| P09al | **done**（`123fff1`） · P3 | ANSI 剥离漏掉 CR/BEL；答案文本与 stderr 片段未剥离（见 [P09al](tickets/P09al-grok-strip-cr-bel-text.md)） |
| P09am | **done**（`2aa235d, dabb632`） · P3 | 完整 prompt 与 rules 位于 argv（ps 可见）（见 [P09am](tickets/P09am-grok-prompt-on-argv.md)） |
| P09an | P3 deferred（合并后） | 失败终态丢失已缓存 usage，仅 usage 遥测（见 [P09an](tickets/P09an-grok-error-drops-usage.md)） |
| P09ao | wontfix | statusless 完成更新中 `rawOutput: null` 未产生 tool_result（见 [P09ao](tickets/P09ao-grok-null-rawoutput-statusless.md)） |
| P09ap | **done**（`9bd87b2, af33ded`） · merged → P09aq | 404 签名误匹配任意 `404 Not Found`（见 [P09ap](tickets/P09ap-grok-404-signature-scope.md)） |
| P09aq | **done**（`9bd87b2, af33ded`） · P2 · 本轮唯一修复（Codex） | 失败分类输入错误：stderr `""` 不回退终态消息（CLI 无关，含 CRLF 与 404 收窄）（见 [P09aq](tickets/P09aq-grok-unknown-model-terminal-message.md)） |
| P09ar | **done**（`9bd87b2, af33ded`） · merged → P09aq | CRLF 被当作回车覆盖，Windows 输出变空行（见 [P09ar](tickets/P09ar-terminal-text-crlf.md)） |
| P09as | wontfix | 凭据透传 allowlist 未按 adapter 区分（见 [P09as](tickets/P09as-spawn-credential-allowlist-per-adapter.md)） |
| P09at | **fixed in code**（`2e64fa0, 0aea2d7`） · superseded → P09bc | 继承 stdout 的后代进程在 drain 后未被终止（见 [P09at](tickets/P09at-process-tree-terminate-spared.md)） |
| P09au | superseded → P09bd | 完整 JSONL 行按 UTF-16 长度而非字节数检查（见 [P09au](tickets/P09au-jsonl-line-bytes.md)） |
| P09av | P3 deferred（合并后） | 同名时间戳取自暂停/恢复等管理回执（见 [P09av](tickets/P09av-store-same-name-timestamp.md)） |
| P09aw | P3 deferred（合并后） | `notice()`/`supersededByThisTurn()` 回执读取未防护（见 [P09aw](tickets/P09aw-reply-state-guard-notice-reads.md)） |
| P09ax | P3（合并后） | 删除 jsonl.ts 旧版 statusless 完成分支（见 [P09ax](tickets/P09ax-grok-remove-statusless-branch.md)） |
| P09ay | **done**（`48874d4`） · P1 | 停止后 final_text 共享闸门对所有 CLI/停止原因放行，policy-guard 停止可能发出被拦截文本（见 [P09ay](tickets/P09ay-run-outcome-final-text-gate-narrow.md)） |
| P09az | **done**（`b4cda3f`） · P1 | 回退 spawn 环境 allowlist（静默剥离各 CLI 必需变量），保留 APP_SECRET 不透传（见 [P09az](tickets/P09az-spawn-env-revert-allowlist.md)） |
| P09ba | — | 不做（用户 2026-10-21） |
| P09bb | **done**（`8949a2d`） · P2 | controls.cfg 缺失时会议仍须有 idle 预算（见 [P09bb](tickets/P09bb-meeting-idle-budget-without-controls.md)） |
| P09bc | **fixed in code**（`2e64fa0, 0aea2d7`） · P2 | SIGKILL 升级跳过持有 stdout 的进程，run 可能不结束（见 [P09bc](tickets/P09bc-process-tree-sigkill-spared.md)） |
| P09bd | P3 | JSONL 8MB 上限按字符索引比较字节（纳入 P09au）（见 [P09bd](tickets/P09bd-jsonl-line-cap-bytes.md)） |

- **#52 Codex 定向 review（`7514c1e`）分诊（2026-10-20）：** 本轮 #52 只修 P09aq（Codex，CLI 无关；并入 P09ar、P09ap）。P09an/at/au/av/aw 为 P3 合并后跟进；P09as、P09ao wontfix；P09ax 合并后删除遗留分支。复盘规则见 tickets/README.md。
- **共享/非 Grok 代码影响评估（2026-10-20，代码阅读，未 live 验证）：** P09aa/ad 修复改动了所有 CLI 共用代码，新增 P09ay（收窄 final_text 闸门）、P09az（回退 env allowlist）；P09ah/ai/aj 修复保留并补测试：P09bb、P09bc、P09bd。均 owner Codex、blocked-by P09aq，P09aq 绿后一批交接。P09ba 不做。
- **#52 Codex review 第 3 轮 triage：** `schedule.ts:526` won't-fix（live 实测：卡显示 3 次、实际触发 3 次）；`channel.ts:2623` deferred P3，见 [P09n](tickets/P09n-settlement-notice-journal-only.md)；`bridge-tool-call.ts:22` 修复已交给 Codex。
- **`44aed11` 后续：** P2（Grok 非 shell 工具被按退出码判失败）已在 `b4d67c6` 修复；`44aed11..b4d67c6` 定向 review 无问题；live 复验发现 [P09o](tickets/P09o-grok-shell-failure-renders-success.md)。
- **`6dd0e44` live 回归（2026-10-20）：** 新增 P09s–P09z。分工：P09s/P09t/P09u 由 local Grok Build 修（代码分支 `feat/bridge-skills`）；P09v/P09w/P09x/P09y 由 Cursor Project 修（同一分支，先 `git pull --rebase`）；P09z 为 deferred。STEP 1 结论：09:00 确认创建了 #19，与 #18（08:45）同名重复；09:00 确认无 toast 但实际成功（P09y），非错误、非 skip-auto-unregistered、非守卫拒绝；#18 为用户本人点击确认。
- **Grok CLI 只读审计（grok 1.0.41，复核于 `93a6c75`，2026-10-20）：** 新增 P09aa–P09am（编号沿用 P09 后缀，P10 已被 UAT 占用），全部 owner 为 local Grok Build。13 项均复核为 CONFIRMED 或 PARTIAL（P09ac/aj/al/am 为 PARTIAL），**无 REJECTED**。合并 #52 前必须修：P09ad（bridge 进程环境中的凭据类变量经 `--always-approve` shell 可读）、P09aa、P09ab。生产与 p09-grok profile 均未配置 Grok 模型（走 CLI 默认），故 P09ac 目前不触发。
- **Won't-fix：** B3 暂停→恢复后 revision 回到原值（ABA），内容相同、无副作用。
- **实测（live）验证：** 场景 1–8 主要路径；F4（拦截成立，见 P09m 误报）；F5；F7 结果为 fail（P09c，已修）。
- **仅代码审阅、未实测：** F6；已授权 user 身份路径（测试 profile 无 user token，bot 身份已实测）。

### 实施完成后的步骤（编排方负责）

1. 确认 #52 CI 全绿。
2. 编排方在 #52 发起**限定范围**的 Codex review，只审 `0b55865..<最终 head>`。
3. 分诊：P1/P2 须能在飞书真实触发才做根因修复并补测试；无法触发记 won't-fix；P3 转延后票。
4. 在飞书 Bot Arena 对修复做可视化复验（卡片、回复、工具卡）。
5. 正常合并 #52（merge commit，**禁止 squash**）。
6. 部署生产 bridge 并做健康检查。
7. 在生产 Grok bridge 上做 P10 UAT。
8. 测试 bridge 保留至 10-26，观察已排期触发：10-21 11:00、10-22 15:00、10-23 10:00/11:00、10-24..26 每天 09:00，另有一个每日重复任务（UTC+8）。
9. 清理测试环境，补建延后的 P3 票。

### 测试环境经验（通用）

- 桌面飞书客户端点卡返回 403，网页客户端（和手机）点击能到达 bridge；这是环境问题，不是 bug。
- 卡片点击只有在发卡的那个 profile 正在运行时才生效；否则日志为 `cardAction skip-auto-unregistered`，toast 显示“此确认已失效”。
- 切换 profile 或重启 bridge 会触发 backfill 重放历史消息（各 profile 的 ledger 分开，可能重复处理）。
- 测试 profile 为调试开启了 `showToolCalls`，生产默认关闭。
- Grok 额度留给 UAT，E2E 优先用 Kimi。

## 夜间端到端测试清单（P09，2026-10-21）

在测试 bridge（#52 最终 head）上对本轮修复做无人值守端到端验证；box 侧覆盖 **Grok、Kimi、Antigravity、Cursor**。Codex / Claude Code 的补测见本节末「Mac 补测」。

### 通用约束

- 只在专用测试群、经测试 profile 发送，正文以 `【端到端测试】` 开头；不触碰生产 bridge 及其进程、配置和状态目录，每阶段确认生产进程未变。
- 开始前及每 30 分钟检查可用内存（>3GB），不足即暂停；不跑本地全量测试套件。
- 每项结束检查 CLI 进程残留，新增孤儿即判该项失败（只清理测试 bridge 进程树）。
- 发现缺陷只记录，不现场修；证据对外发布前脱敏（无会话/消息/用户 ID、人名、凭据、本机路径）。
- Grok 额度留给 UAT：Grok 项合并为少量 run，通用回归优先用 Kimi。

### 前置（任一失败则中止）

| ID | 内容 | 期望 |
| --- | --- | --- |
| PRE-1 | 内存与生产隔离基线 | 内存充足；生产进程存在且启动时间未变 |
| PRE-2 | 测试 bridge 构建自 #52 最终 head（仅装依赖与构建） | 构建 SHA = #52 head |
| PRE-3 | 测试 profile 连通 | 测试 bot 在测试群回复 |
| PRE-4 | 各 CLI 版本/登录状态 | 记录；不可用者标"未验证" |
| PRE-5 | 测试 bridge 导出无害环境哨兵变量 | 供环境检查使用 |

### 本轮修复验证（FX）

| ID | 票 | 步骤 | 期望（PASS 条件） |
| --- | --- | --- | --- |
| FX-a | P09a | "每天 09:00 提醒，从明天到下月同日（不含）" | 卡片显示精确次数，非"约每月 N 次" |
| FX-b | P09b | 自动化请求后停测试 bridge 30s 再启，走重连补发 | 用户消息补发仍可创建；bot 自身消息仍被拒 |
| FX-c | P09c | 建确认卡后以 user_card_content 读回 | delivery 已绑定卡；schema 2.0、确定性 element_id |
| FX-v | P09v | 得卡 A（不点）→"改成 08:45"→得卡 B | A 标记取代；确认 B 后 A 显示"已被新卡取代"且按钮移除（见下"预期行为"） |
| FX-aa/ay1 | P09aa、P09ay | Grok 先输出答案再长 sleep，中途停止 | 暂存答案恰好发出一次 |
| FX-ay2 | P09ay | 同上用 Codex | 恰一次（Mac 补测） |
| FX-ay3 | P09ay | 定时 agent 任务触发 policy-guard 停止 | 有中断通知，无 final_text 答案 |
| FX-bc | P09bc（含 ai） | 后台派生子进程后停止 | grace 内结束，无残留进程 |
| FX-o/s | P09o、P09s | 开 showToolCalls，执行失败命令 | 工具卡显示失败；只一个 tool_result |
| FX-t/ab/u | P09t、P09ab、P09u | 输出带 ANSI/CR/BEL 的中文 | 工具卡无转义序列、无 Node 颜色警告，中文完好 |
| FX-af | P09af | 开 thinking 显示，问推理题 | 卡片出现思考内容；不误触 idle 超时 |
| FX-ac | P09ac | 查看模型列表 | 不含不存在的模型 |
| FX-ag/aq | P09ag、P09aq（含 ap、ar） | 错误模型名 / 不存在会话 / 非 Grok CLI 错误模型 | 模型指引或会话不存在提示；普通 "404" 工具输出不误判 |
| FX-ae | P09ae | 访问模式设只读，检查 Grok argv | 无 always-approve，权限参数与状态一致，写入被拒 |
| FX-az | P09az、P09ad | 各 CLI 输出环境变量名与哨兵、统计密钥类变量 | 普通变量与 provider 凭据可见；bridge 密钥计数为 0（泄露即 P0 FAIL） |
| FX-bb | P09bb、P09ah | 会议模式无 controls 配置，执行长时间无输出命令 | idle 预算内结束并提示，无残留 |
| FX-bd（可选） | P09bd | 输出超字节上限的单行中文 JSON | 按字节超限失败，内存稳定 |
| FX-P3（可选） | d–m、p–r、w–y | 顺带观察标签、回复字段、替换卡文案、lastStatus、预设、help 不被拦截 | 仅记录 |

### 既有功能回归（R）

CLI 矩阵：Grok（必测）、Kimi（主力）、Cursor、Antigravity；Codex / Claude Code 在 Mac 补测。

| ID | 功能 | 期望 |
| --- | --- | --- |
| R-1 | 群内 @ 问答 | 流式卡片→正确答案（每 CLI 独立判定） |
| R-2 | 测试工作区建文件并读回 | 文件存在，工具卡正常 |
| R-3 | 会话延续 | 引用上一轮 |
| R-4 | 新会话 / 恢复 | 上下文正确隔离/恢复 |
| R-5 | 切换工作区 | `pwd` 为新目录 |
| R-6 | 停止任务 | 立即停止，无孤儿 |
| R-7 | 多 profile 并存 | 生产无测试流量 |
| R-8 | 飞书上下文读取（wiki、近期消息） | 读取成功 |
| R-9 | Web 控制台列出 profile | 正常显示 |
| R-10 | showToolCalls 多工具 | 折叠与状态图标正常，无字节数组、无 ANSI |
| R-ENV | 子进程环境 | 各 CLI 正常启动登录（凭据透传未断） |
| R-11 | 插件/skills 发现（A01–A05） | 列出内置包，摘要+按需读取 |
| R-12 | 插件根目录缺失（A16） | 诊断 `missing-root`，其他插件可用 |
| R-13 | 重启测试 bridge（A12/A15） | 会话与任务保留，无重复卡 |

### 自动化（AU）

| ID | 内容 | 期望 |
| --- | --- | --- |
| AU-1 | 每 10 分钟，T+20 到 T+50（不含） | 预览恰 3 次，endAt 不含 |
| AU-2 | 缺结束边界 | needs-input 卡，不建任务 |
| AU-3 | 一次性提醒 T+15 | 准时触发一次（偏差 ≤1 分钟） |
| AU-4 | 间隔任务窗口 | 恰 3 次，窗口末不触发 |
| AU-5 | 定时 agent 任务（A13/A14） | 自动 run 执行并发结果，lastStatus ok |
| AU-6 | 自动 run 执行认证登出（F4） | 返回 `auth-config`、任务暂停、凭据不变；`--help` 不被拦截 |
| AU-7 | 自动 run 内再建定时任务（F5） | 被拒 |
| AU-8 | 列表/暂停/恢复/替换/删除（A10） | 先查询再出确认卡；新任务 lastStatus never |
| AU-9 | 旧 revision 替换 / 同请求重发（F2/F3） | 失败不影响他项；不出第二张卡/任务 |
| AU-10 | 窗口中途重启测试 bridge | 不丢、不重复触发 |
| AU-11 | 清理 | 测试任务列表为空 |

需人工点击（agent 无法代点卡片按钮）：确认卡点「是」使 AU-3/4/5/8 生效；P09v 新旧卡；P09y 连续确认；P09i 结束日期预设；P09e 最终回复前点卡。无人点击时相关项标"阻塞-需人工"，agent 侧只核验卡片内容与存储草稿。

### 自然语言排期识别（NL，10 句）

- CLI：**Grok、Kimi、Antigravity（模型手动设为 Gemini 3.8 Flash）**，三者跑同一完整集合。
- 每句单独发送；**NL 卡片一律不点击**（用户随手点击不影响判定）。
- **PASS** = 出现确认卡（或补全结束日期/澄清卡），日期时间按发送时刻、Asia/Shanghai 解析，次数/预览、重复规则、结束条件正确；工作日跳过周末；模糊句追问或在卡上明示所选解释。**FAIL** = 只有纯文本无卡（模糊句追问除外）或卡上日期/次数/规则错误。
- 基准：发送日 D = 2026-10-21（周三），全部句子当天发送。

| ID | 句子 | 期望解析 |
| --- | --- | --- |
| NL01 | 十分钟后提醒我喝水 | 一次性，发送时刻 +10 分钟（共 1 次） |
| NL02 | 未来三天每天早上9点提醒我背单词 | 每日 09:00 共 3 次；早于当天 09:00 可从 10-21 起，否则 10-22～10-24；卡片明示 3 个日期 |
| NL03 | 下周四周五每天上午10点和下午4点提醒我看盘 | 10-29、10-30 各 10:00/16:00，共 4 次（可拆多任务） |
| NL04 | 下周五下午3点提醒我开复盘会 | 一次性 10-30 15:00（若取 10-23 须明示，记"可接受-需审"） |
| NL05 | 下个工作日上午10点提醒我提交报销 | 一次性 10-22 10:00 |
| NL06 | 下周每个工作日早上9点半提醒我开站会 | 10-26～10-30 09:30 共 5 次，结束 10-31 00:00（不含） |
| NL07 | 下个周末两天，从早上9点到晚上9点每3小时提醒我喝水 | 10-24/25（或 10-31/11-01，须明示）；09/12/15/18 点（21 点是否含须明示）；夜间不触发 |
| NL08 | 每周一三五早上8点提醒我跑步，持续两周 | 一、三、五 08:00，两周共 6 次，起止一致 |
| NL09 | 工作日每天下班前（18:00）提醒我写日报，到本月底 | 10-21～10-30 工作日 18:00 共 8 次，跳过周末，结束不晚于 11-01 00:00 |
| NL10 | 周五下午提醒我写周报 | 模糊：追问时间，或取 10-23 某下午时刻并明示 |

不含"每月"类排期。被确认的 NL 任务在最终清理时列出并删除。

### 预期行为（已确认）

- **修订卡取代**：确认修订后的新卡时，旧卡立即显示"已被新卡取代"且按钮移除，无法再点。用户确认这是预期行为，判 **PASS**；原"新旧两卡都点「是」"步骤改为"旧卡按钮消失即通过"。

### 收尾判定

纳入的 FX 全 PASS、R 在 Grok 与 Kimi 上全 PASS、FX-az 无密钥泄露 → 本轮通过；需人工/阻塞项单列。

### Mac 补测：Codex / Claude Code

box 运行只覆盖 Grok / Kimi / Antigravity / Cursor。以下项目由用户之后在 Mac 上分别用 **Codex** 和 **Claude Code** 补测，判定标准同上：

- **回归**：R-1、R-2、R-3、R-4、R-5、R-6、R-10、R-11（R-7/R-8/R-9/R-12/R-13 与 CLI 无关，box 结果可沿用，Mac 上可选）。
- **环境检查**：FX-az / R-ENV —— 普通变量与 provider 凭据可见、bridge 密钥计数为 0、CLI 正常启动登录。
- **修复验证**：FX-ay2（Codex 停止后答案恰一次；Claude Code 同法）、FX-bc/R-6（停止无残留）、FX-o/s 与 FX-t/ab/u 的工具卡表现（失败状态、无 ANSI）、FX-ag/aq(c)（错误模型名给出模型指引）、FX-ae 对应的访问模式参数与状态一致、FX-v（修订卡取代，旧卡"已被新卡取代"且按钮移除）。
- **自动化**：AU-1、AU-2、AU-5（定时 agent 任务以该 CLI 执行）、AU-6、AU-7、AU-8，结束后 AU-11 清理。
- **自然语言排期**：NL01–NL10 全集，规则同上（确认卡日期/次数/结束正确即 PASS，卡片不点击）。

## 本版解决什么

用户用自然语言安排自动化，agent bot 需要知道可用能力和正确调用方法，并在本轮得到工具结果。现有最终回复提案把校验放在 agent 结束之后，无法形成正常工具反馈；仅迁移说明文字不足以解决问题。

新方案以 bridge plugin 为管理单元，支持 skills、资源、脚本/命令，默认先暴露插件简介。automation 是第一个实装，通过共用客户端调用已有业务模块。模型推理留在各 CLI runtime，bridge 返回实际执行状态。bot 与已授权 user 操作均受支持，组织自行管理账号、权限与使用风险。

## 已确认范围

| 本次交付目标 | 延期或范围外 |
| --- | --- |
| 插件包验证、发现、按需读取和普通脚本扩展 | 市场、在线安装、管理界面、MCP、hooks、常驻插件进程 |
| 六种 CLI 的共用调用契约与运行上下文绑定 | 各 CLI 原生插件管理、通用执行平台、主机权限隔离 |
| automation 的结构化请求、同轮反馈、真实状态与既有业务接线 | 原 B04–B06 的其他业务说明迁移、Base 巡检插件 |
| 支持 profile 已接入的 bot/user 身份，创建者单独记录 | 逐用户授权选择、账号迁移、换账号后的任务重确认 |
| 旧提案执行路径退出，已有任务与草稿继续有效 | 永久双协议、借“兼容”保留两套业务处理 |

完整契约以规格为准；表格不替代验收条款。

## 与 Revision 2.1 的关键差异

- skill pool 扩展为 plugin 管理与逐层发现；首层目录按插件展示。
- 正常工具调用替代最终回复中的 `automation_proposal` 执行路径；B02 的下一次用户发言反馈不再是主方案。
- 参数采用结构化排期，直接使用既有排期校验与计算；机器入口不绕回文本时间语法。
- 结果必须来自实际保存/投递/状态，不以预先拼出的成功行或 skill 措辞代替。
- 自动化支持 bot＋user，撤销旧规格的 bot-only 假设；使用已有授权与修改 profile 认证配置分开，后者在自动 run 继续拦截。自动与人工 run 共用 profile 的 lark-cli 环境，刷新由 CLI 自身负责。
- 组织运维与账号变更不扩成新产品治理流程。
- 以完整业务链和真实客户端契约为测试重点，覆盖六种 CLI；skill 读取率只是辅助信号。
- 无关的 prompt 搬迁不再成为本次 automation 交付的前置条件。

## 当前代码导航

核对基线为 `master@953e7bdde3549b03bddb8d191d8856683d1dc4c5`，包含 PR49。路径是导航，不代表新设计已经实现。

| 当前事实 | 定位入口 |
| --- | --- |
| agent 结束后解析回复提案，形成结果行再应用 | [channel.ts](../../../src/bot/channel.ts)、[proposal.ts](../../../src/automations/proposal.ts) |
| 既有人工命令、提案校验、确认与任务变更 | [command.ts](../../../src/automations/command.ts) |
| 已有结构化排期、调度与持久化 | [schedule.ts](../../../src/automations/schedule.ts)、[scheduler.ts](../../../src/automations/scheduler.ts)、[store.ts](../../../src/automations/store.ts) |
| 六种 adapter 共用环境注入，尚无本轮业务回调绑定 | [lark-channel-env.ts](../../../src/agent/lark-channel-env.ts)、[agent types](../../../src/agent/types.ts) |
| runner 写入 prompt 后关闭 stdin，事件观察不是工具回填 | [jsonl-cli-runner.ts](../../../src/agent/runner/jsonl-cli-runner.ts) |
| bot-only 提示与工具事件拦截需要按新需求修正 | [bridge-system-prompt.ts](../../../src/agent/bridge-system-prompt.ts)、[policy-guard.ts](../../../src/automations/policy-guard.ts)、[agent-run.ts](../../../src/automations/agent-run.ts) |
| profile 私有 Lark CLI 配置与既有身份策略 | [app-paths.ts](../../../src/config/app-paths.ts)、[identity-policy.ts](../../../src/lark-cli/identity-policy.ts) |

当前 task 保存 createdBy，不保存创建者的 OAuth 授权；现有桥接路径也不会按聊天发送者自动切换个人账号。新规格沿用 profile 已接入身份，不新增逐用户身份模型。

## 测试入口与完成证据

用户已确认规格 T1–T4：以 `startChannel` 完整链为主，额外测试 plugin catalog interface 和 CLI process interface；六种 CLI 均需覆盖。只观察最终文案或 fake 成功响应不能证明新通道有效。

可复用范式：

- [自然语言创建](../../../tests/integration/bot/auto-nl-creation.test.ts)、[回复结果](../../../tests/integration/bot/auto-proposal-reply.test.ts)、[删除与替换](../../../tests/integration/bot/auto-nl-delete-replace.test.ts)。
- [自动任务运行](../../../tests/integration/bot/auto-agent-task-run.test.ts)、[交付 outbox](../../../tests/integration/bot/auto-delivery-outbox.test.ts)、[原身份策略测试](../../../tests/integration/bot/auto-agent-safety.test.ts)。
- [process 测试目录](../../../tests/process/)已有六种 CLI 的 opt-in 真实 smoke；执行时依本机或部署环境的真实测试指引，不能用 mock 通过代替真实验收。

代码阶段遵循项目 TDD 和 `pnpm ci:local` 门禁。文档阶段仅核验路径、链接、状态、内容与范围；本次没有运行生产服务或功能验收。

## 当前拆票与后续工作

P01–P09 已覆盖完整首版范围，依赖及共同接口见 [tickets](tickets/README.md)。P01、P03 无业务前置；其他票按实际依赖进入 frontier，不恢复 B01–B07 的旧顺序。代码实施、任务认领与代码分支尚未开始；文档就绪不等于已获准编码。

本次同步了远端 `0624458` 的 D8 补充。用户提供的 Grok Bot 环境核验支持沿用同一 profile 的授权/刷新路径；它不是新插件工具链或六种 CLI 的功能通过证据。P03/P09 仍需记录实际依赖版本及运行结果。

## 各票代码与验证导航

以下 Files 是按当前代码核对的入口；具体新增模块由票内接口和实现决定。实施 brief 必须连同本表、共同契约和完整票正文提供，不能把导航当作限定只能改一个文件。每票的 Verification loop 规定先失败、再实现、再复验；最终执行项目代码门禁。

| 票 | Files / 当前变更入口 | 首轮验证 |
| --- | --- | --- |
| P01 | [CLI](../../../src/cli/index.ts)、[共用环境](../../../src/agent/lark-channel-env.ts)、[运行入口](../../../src/runtime/run-executor.ts)、[群接线](../../../src/bot/channel.ts)、[排期](../../../src/automations/schedule.ts)、[命令业务](../../../src/automations/command.ts)、[构建打包](../../../package.json) | `startChannel` 真实客户端预览；catalog/process；打包后读取 |
| P02 | [命令业务](../../../src/automations/command.ts)、[存储](../../../src/automations/store.ts)、[调度](../../../src/automations/scheduler.ts)及 P01 新调用模块 | 自然语言创建、确认卡、周期边界、存储/发卡故障、进程重启 |
| P03 | [自动任务](../../../src/automations/agent-run.ts)、[guard](../../../src/automations/policy-guard.ts)、[系统提示](../../../src/agent/bridge-system-prompt.ts)、[共用环境](../../../src/agent/lark-channel-env.ts)、[身份策略](../../../src/lark-cli/identity-policy.ts)、[运维](../../operations.md) | 自动任务身份集成；真实子进程环境；认证配置变更回归 |
| P04 | [自动任务](../../../src/automations/agent-run.ts)、[运行入口](../../../src/runtime/run-executor.ts)、[创建业务](../../../src/automations/command.ts)及 P01/P02 新模块 | 创建 → 确认 → 实际 agent fire → 交付；递归管理拒绝 |
| P05 | [命令业务](../../../src/automations/command.ts)、[存储](../../../src/automations/store.ts)及 P02 操作回执 | 删除/替换、暂停/恢复、看板确认、并发旧状态 |
| P06 | P01 catalog/内容读取模块、[构建打包](../../../package.json)、[setup](../../agent-setup.md)、[运维](../../operations.md) | 临时真实包、实际脚本、版本与续会话、坏包隔离 |
| P07 | [六种 adapters](../../../src/agent/)、[共用环境](../../../src/agent/lark-channel-env.ts)、[runner](../../../src/agent/runner/jsonl-cli-runner.ts)、[process](../../../tests/process/) | 六 CLI 新/续会话与实际工具循环；三平台进程契约 |
| P08 | [群接线](../../../src/bot/channel.ts)、[旧提案](../../../src/automations/proposal.ts)、[命令业务](../../../src/automations/command.ts)、[存储](../../../src/automations/store.ts)、[系统提示](../../../src/agent/bridge-system-prompt.ts) | 固定旧数据升级、旧卡片完成、新旧混合无重复 |
| P09 | [process](../../../tests/process/)、[integration](../../../tests/integration/bot/)及所选测试部署；缺陷按对应原票定位 | 依项目真实飞书指引执行 T4；汇总 A01–A16 与六 CLI 证据 |

定向命令沿用 `pnpm test:process`、`pnpm test:integration`，或 `pnpm exec vitest run` 加本票实际用例；只有满足各票可观察验收才算通过。文档阶段没有运行这些功能检查。


## 低优先级 / 合并后再评估（用户 2026-10-21 标记）

以下票不在 #52 本轮，不交给 Codex，#52 合并后再评估。正常使用基本碰不到。

| 票 | 白话说明 |
|---|---|
| P09an | Grok 失败时这次运行的 token/费用统计会丢，只影响用量统计。 |
| P09av | 两个任务重名时，用来区分的时间戳有时取自暂停/恢复操作，而非创建时间。 |
| P09aw | 读确认卡回执的一处代码缺防护，仅数据异常时可能出错。 |
| P09ax | 删除旧版 Grok 兼容代码（做减法），改不改都行。 |
| P09n | 回复发完后才点确认卡时，“已确认”提示只进内部日志，没补到群消息上。 |
| P09z | Codex 早期审查留下的两个理论边缘情况（点卡极短时间窗口；去重不区分点击者）。 |
| P09au | 长度上限按字符而非字节计算；随 P09bd 一并解决。 |
| P09-real-feishu-acceptance | 不是修复票，是整轮验收清单，由夜间端到端测试执行。 |

本轮仍在做：P09bd（Codex）。代码已修、待最终版本实测：P09bc、P09at、P09ai。搁置：P09be、P09bf。不做：P09ao、P09as、P09ba。
