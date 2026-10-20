# PR51 tickets — Revision 3

Status: ready-for-agent（拆票完成，代码实施尚未授权）· 2026-10-19

依据 [Revision 3 规格](../../bridge-skills.md)，包含 `0624458` 的 D8 身份补充。用户已将拆分粒度与依赖交由工程判断；采用以下 9 张完整交付切片。每票一个文件，旧 B01–B07 继续 superseded，不复用旧执行顺序。[HANDOFF](../HANDOFF.md)提供代码和验证导航。

## 当前阶段与执行边界

- 本次完成 to-tickets，更新既有文档 PR；不创建 GitHub Issues、不修改生产代码、不启动服务、不合并 PR。ready-for-agent 表示票内容可供下一阶段认领，不等于现在获准编码或真实测试。
- 九票共同完成一个首版范围。最初只读链和提醒链是中间验收切片，不是缩减后的最终版本；兼容包、所有操作和六种 CLI 都保留。
- 后续代码在一条功能集成分支逐票验证，完整交付前不把中间切片部署为完成版。新增入口的可用能力必须真实；同一个 run 不同时执行新工具和旧回复提案。
- P01–P07 扩展并迁移能力，P08 删除旧执行协议及临时迁移接线，P09 验收同一最终版本。既有业务回归在各票保持有效，不将全部测试推迟到末尾。
- 原始可执行 frontier 为 P01、P03。依赖只表示必要前置，不授予并行写入许可；实施方式和派工遵循项目规则，不在文档票中另建调度制度。

## 交付切片与真实依赖

| 票 | 可观察交付 | Blocked by |
| --- | --- | --- |
| [P01](P01-discover-and-preview.md) | 内置 automation 发现、查询、排期预览及本轮反馈 | None |
| [P02](P02-create-reminder.md) | 提醒创建、确认、执行及去重恢复 | P01 |
| [P03](P03-profile-identity.md) | 现有自动任务使用 profile 的 bot/user 身份 | None |
| [P04](P04-create-agent-task.md) | 新入口创建 agent 任务，自动 run 读取插件并执行 | P02、P03 |
| [P05](P05-manage-tasks.md) | 既有任务查询、替换、暂停、恢复和删除 | P02 |
| [P06](P06-external-plugins.md) | 外部兼容插件、脚本、依赖与版本生命周期 | P01 |
| [P07](P07-six-cli-contract.md) | 六种 CLI 的完整共同调用契约 | P04、P05、P06 |
| [P08](P08-cutover-and-upgrade.md) | 唯一入口切换、旧协议退出与存储升级 | P07 |
| [P09](P09-real-feishu-acceptance.md) | 真实飞书 E2E 验收（无 UAT）：Grok Build、Antigravity、Cursor CLI、Kimi 待验收，其余 CLI 标记未验证 | P08 |
| [P09a](P09a-recurring-count-copy.md) | Bug P2：周期确认卡次数文案错误（每天一个月显示“约每月 28 次”，应为“共 31 次”） | P09 发现 |
| [P09b](P09b-backfill-requires-human.md) | Bug P2：重连补发的真人消息未保留 raw，automation 全部判为 `automation-requires-human` | P09 发现 |
| [P09c](P09c-card-readback-reconcile.md) | Bug P2：发卡结果未知时回读对账不带 `card_msg_content_type` 且依赖不回传的 `auto_token`，草稿永远绑不上卡（F7 fail） | P09 发现 |
| [P09d](P09d-bridge-tool-call-label.md) | Bug P3：`showToolCalls` 原样展示内部 bridge tool 命令与协议 JSON，应折叠为“自动化：list/create…”标签（修订 D5） | P09 发现 |
| [P09e](P09e-card-click-reply-race.md) | Bug P3：最终回复发出前已点卡，回复仍写“待确认”，与卡片状态矛盾 | P09 发现 |
| [P09f](P09f-reply-protocol-fields.md) | Bug P3：回复原样搬运 `waiting-confirmation`、`applied` 等协议字段（skill 文案） | P09 发现 |
| [P09g](P09g-replace-card-copy.md) | Bug P3：替换确认卡正文“将删除：#N”易误解为删除 | P09 发现 |
| [P09h](P09h-laststatus-never-fired.md) | Bug P3：从未触发的任务 `lastStatus` 初始为 `ok` | P09 发现 |
| [P09i](P09i-end-date-presets.md) | Bug P3：补全结束日期卡最短预设为一个月 | P09 发现 |
| [P09j](P09j-plugin-conflict-shadowing.md) | Bug P3：同名冲突包遮蔽合法包，`skill-ambiguous` 无法用选择器消歧 | P09 发现 |
| [P09k](P09k-missing-root-diagnostic.md) | Bug P3：插件目录不存在时返回未文档化的 `invalid-package` | P09 发现 |
| [P09l](P09l-grok-tool-output-bytes.md) | Bug P3：Grok 工具进度卡把 Bash 输出显示为十进制字节数组 | P09 发现 |
| [P09m](P09m-policy-guard-help-false-positive.md) | Bug P3：只读 `auth logout --help` 被误判 `auth-config` 并暂停任务；`auth-config` 不在工具结果中 | P09 发现 |
| [P09n](P09n-settlement-notice-journal-only.md) | Bug P3（deferred，不进 #52）：最终渲染后结算确认卡，结算提示只写入 journal、未补到已流式消息 | #52 Codex 第 3 轮 |
| [P09o](P09o-grok-shell-failure-renders-success.md) | Bug P2：Grok shell 退出码非 0 仍显示成功（shell 判定漏 `run_terminal_command`） | `b4d67c6` live 复验 |
| [P09p](P09p-superseded-draft-card-still-live.md) | Bug P3：草稿修订后旧确认卡仍有效，点「是」重复建任务 | `b4d67c6` 全量回归 |
| [P09q](P09q-multi-draft-reply-leaks-fields.md) | Bug P3：多草稿状态回复泄漏 `applied` 字段与完整卡片 / 草稿 ID | `b4d67c6` 全量回归 |
| [P09r](P09r-tool-card-ansi-escapes.md) | Bug P3：工具卡出现 ANSI 颜色码（与 NO_COLOR/FORCE_COLOR 警告同修） | `b4d67c6` 全量回归 |
| [P09s](P09s-grok-statusless-update-as-result.md) | Bug P2（owner: local Grok Build）：Grok 无 status 的 tool_call_update 被当作结果，shell 退出码被忽略（重开 P09o） | `6dd0e44` live 回归 |
| [P09t](P09t-grok-ansi-raw-string-bytes.md) | Bug P2（owner: local Grok Build）：Grok 原始字符串 / 字节数组 rawOutput 未剥离 ANSI（Codex review #2） | `6dd0e44` live 回归 |
| [P09u](P09u-grok-force-color-no-color-warning.md) | Bug P2/P3（owner: local Grok Build）：Grok shell 自设 FORCE_COLOR，与 NO_COLOR 冲突产生 Node 警告（重开 P09r） | `6dd0e44` live 回归 |
| [P09v](P09v-draft-revision-without-supersede.md) | Bug P2（owner: Cursor Project）：修订草稿时模型未传 supersedesOperationId，旧卡仍有效，live 产生重复任务 #18/#19 | `6dd0e44` live 回归 |
| [P09w](P09w-same-turn-supersede-label.md) | Bug P3（owner: Cursor Project）：同轮取代的草稿被标为「回复生成期间已失效」 | `6dd0e44` live 回归 |
| [P09x](P09x-reply-count-and-status-codes.md) | Bug P3（owner: Cursor Project）：回复次数（31）与卡片（30）不一致，并泄漏 needs-input / waiting-confirmation | `6dd0e44` live 回归 |
| [P09y](P09y-confirm-success-without-feedback.md) | Bug P3（owner: Cursor Project）：确认已成功（#19）但按钮复原、无 toast | `6dd0e44` live 回归 |
| [P09z](P09z-deferred-review-findings-1-3.md) | Deferred P3（owner: Cursor Project）：Codex review #1 setImmediate 结算窗口、#3 指纹不含 actor；证据表明均不产生重复 | `6dd0e44` live 回归 |
| [P09aa](P09aa-grok-stop-drops-final-text.md) | Bug P1（owner: local Grok Build）：停止/空闲超时时 Grok 的暂存答案被丢弃 | Grok CLI 只读审计 |
| [P09ab](P09ab-grok-tool-env-node-color-warning.md) | Bug P1（owner: local Grok Build）：P09u 不完整：Grok 工具进程自设 NO_COLOR+FORCE_COLOR，Node 警告仍进工具卡 | Grok CLI 只读审计 |
| [P09ac](P09ac-grok-model-list-invalid.md) | Bug P2（owner: local Grok Build）：Profile 模型列表含不存在的 `grok-build`，错误被泛化 | Grok CLI 只读审计 |
| [P09ad](P09ad-grok-env-inherits-bridge-secrets.md) | Bug P1（owner: local Grok Build）：Grok 及其 shell 继承 bridge 全部进程环境（含凭据类变量） | Grok CLI 只读审计 |
| [P09ae](P09ae-grok-access-mode-ignored.md) | Bug P2（owner: local Grok Build）：Profile 访问模式不映射到 grok argv（read-only 仍 --always-approve） | Grok CLI 只读审计 |
| [P09af](P09af-grok-thought-dropped.md) | Bug P2（owner: local Grok Build）：Grok `thought` 被丢弃：CoT 为空，idle 计时视为静默 | Grok CLI 只读审计 |
| [P09ag](P09ag-grok-failure-signatures.md) | Bug P2（owner: local Grok Build）：Grok 恢复失败/未知模型被归为通用可重试失败 | Grok CLI 只读审计 |
| [P09ah](P09ah-meeting-no-idle-watchdog.md) | Bug P2（owner: local Grok Build）：会议运行无 idle watchdog，挂起的 grok 无限期存活 | Grok CLI 只读审计 |
| [P09ai](P09ai-stop-leaves-grandchildren.md) | Bug P2（owner: local Grok Build）：停止只信号 grok pid，孙进程（shell 工具）存活 | Grok CLI 只读审计 |
| [P09aj](P09aj-jsonl-line-unbounded.md) | Bug P3（owner: local Grok Build）：单行 JSONL 无大小上限地缓冲 | Grok CLI 只读审计 |
| [P09ak](P09ak-grok-readfile-blob-usage-dup.md) | Bug P3（owner: local Grok Build）：`read_file` 工具卡显示 JSON 原文；usage 事件发三次 | Grok CLI 只读审计 |
| [P09al](P09al-grok-strip-cr-bel-text.md) | Bug P3（owner: local Grok Build）：ANSI 剥离漏掉 CR/BEL；答案文本与 stderr 片段未剥离 | Grok CLI 只读审计 |
| [P09am](P09am-grok-prompt-on-argv.md) | Bug P3（owner: local Grok Build）：完整 prompt 与 rules 位于 argv（ps 可见） | Grok CLI 只读审计 |
| [P09an](P09an-grok-error-drops-usage.md) | Deferred P3（owner: local Grok Build，合并后跟进）：失败终态（translateError/fail）丢失已缓存 usage（仅 usage 遥测） | #52 Codex 定向 review（`7514c1e`） |
| [P09ao](P09ao-grok-null-rawoutput-statusless.md) | Wontfix（owner: local Grok Build）：statusless 完成更新中 `rawOutput: null` 未产生 tool_result | #52 Codex 定向 review（`7514c1e`） |
| [P09ap](P09ap-grok-404-signature-scope.md) | Merged → P09aq：404 签名误匹配任意 `404 Not Found` | #52 Codex 定向 review（`7514c1e`） |
| [P09aq](P09aq-grok-unknown-model-terminal-message.md) | **Bug P2，本轮 #52 唯一修复**（owner: Codex，CLI 无关）：失败分类输入错误（stderr `""` 不回退终态消息）；并入 P09ar、P09ap | #52 Codex 定向 review（`7514c1e`） |
| [P09ar](P09ar-terminal-text-crlf.md) | Merged → P09aq：CRLF 被当作回车覆盖，Windows 输出变空行 | #52 Codex 定向 review（`7514c1e`） |
| [P09as](P09as-spawn-credential-allowlist-per-adapter.md) | Wontfix（owner: Codex（CLI 无关，邮件交接））：凭据透传 allowlist 未按 adapter 区分 | #52 Codex 定向 review（`7514c1e`） |
| [P09at](P09at-process-tree-terminate-spared.md) | Deferred P3（owner: Codex，合并后跟进）：继承 stdout 的后代进程在 drain 后未被终止 | #52 Codex 定向 review（`7514c1e`） |
| [P09au](P09au-jsonl-line-bytes.md) | Deferred P3（owner: Codex，合并后跟进）：完整 JSONL 行按 UTF-16 长度而非字节数检查 | #52 Codex 定向 review（`7514c1e`） |
| [P09av](P09av-store-same-name-timestamp.md) | Deferred P3（owner: Codex，合并后跟进）：同名时间戳取自暂停/恢复等管理回执 | #52 Codex 定向 review（`7514c1e`） |
| [P09aw](P09aw-reply-state-guard-notice-reads.md) | Deferred P3（owner: Codex，合并后跟进）：`notice()`/`supersededByThisTurn()` 回执读取未防护 | #52 Codex 定向 review（`7514c1e`） |
| [P09ax](P09ax-grok-remove-statusless-branch.md) | Chore P3（owner: local Grok Build，#52 合并后）：删除 jsonl.ts 旧版 statusless 完成分支 | P09ao 分诊 |
| [P09ay](P09ay-run-outcome-final-text-gate-narrow.md) | Bug P1（owner: Codex，#52，blocked-by P09aq）：停止后 final_text 共享闸门对所有 CLI/停止原因放行，policy-guard 停止可能发出被拦截文本 | 共享/非 Grok 代码影响评估（`7514c1e` vs `953e7bd`） |
| [P09az](P09az-spawn-env-revert-allowlist.md) | Bug P1（owner: Codex，#52，blocked-by P09aq）：回退 spawn 环境 allowlist（静默剥离各 CLI 必需变量），保留 APP_SECRET 不透传 | 共享/非 Grok 代码影响评估（`7514c1e` vs `953e7bd`） |
| [P09ba](P09ba-spawn-env-hardening-redesign.md) | Chore P3（owner: Codex，#52 合并后独立 PR）：重新设计环境加固 + 按 adapter 环境契约测试 | 共享/非 Grok 代码影响评估（`7514c1e` vs `953e7bd`） |
| [P09bb](P09bb-meeting-idle-budget-without-controls.md) | Test P2（owner: Codex，#52，blocked-by P09aq）：controls.cfg 缺失时会议仍须有 idle 预算 | 共享/非 Grok 代码影响评估（`7514c1e` vs `953e7bd`） |
| [P09bc](P09bc-process-tree-sigkill-spared.md) | Test/Bug P2（owner: Codex，#52，blocked-by P09aq）：SIGKILL 升级跳过持有 stdout 的进程，run 可能不结束 | 共享/非 Grok 代码影响评估（`7514c1e` vs `953e7bd`） |
| [P09bd](P09bd-jsonl-line-cap-bytes.md) | Bug P3（owner: Codex，#52，blocked-by P09aq）：JSONL 8MB 上限按字符索引比较字节（纳入 P09au） | 共享/非 Grok 代码影响评估（`7514c1e` vs `953e7bd`） |

> **分诊原则：** 票据按第一性原理、面向未来判断；不为过时的 CLI 版本做兼容工作（做减法，不打补丁）。

### P09a–P09m 依赖与实施顺序（按 `0b55865` 代码路径）

同组内文件重叠，须按序串行（后者 rebase 在前者之上）；各组之间无文件重叠，可并行。

| 组 | 顺序 | 重叠文件 |
| --- | --- | --- |
| G1 | P09b → P09d → P09e → P09f | `src/bot/channel.ts`（b/d/e）；automation `SKILL.md`（d/f） |
| G2 | P09a → P09g | `src/automations/confirm-card.ts` |
| G3 | P09k → P09j | `src/plugins/catalog.ts`、`docs/operations.md` |
| G4 | P09h → P09m | `src/automations/store.ts`（h 改 lastStatus 初值；m 的 policy-guard 结果经 store/agent-run 落地） |
| G5 | P09c | `src/automations/draft-delivery.ts`、`src/bot/feishu-delivery.ts` |
| G6 | P09i | `src/automations/end-card.ts` |
| G7 | P09l | `src/agent/grok/jsonl.ts` |

P09d（`src/card/tool-render.ts`）与 P09l（`src/agent/grok/jsonl.ts`）都影响工具进度卡但不共享文件，可并行；合并后需一并确认 Grok 工具卡既解码字节又折叠 bridge tool 标签。
| [P10](P10-uat-real-usage.md) | 生产 Grok bridge 真实使用 UAT：14 条自然语言句子覆盖提醒、文档、新闻摘要与五类排期及管理操作，核对 larkent-monitor | P09、#52 合并并部署 |

#52 Codex 定向 review（`7514c1e`）复盘规则（2026-10-20）：

- #52 只接受 automation / plugin 范围内的问题；其他通用发现一律建为 #52 合并后的跟进票。
- 修复票的回归测试必须覆盖受影响的调用方，不能只测辅助函数。
- P3 票是合并后跟进，不在 #52 中修。本轮 #52 只修 P09aq（已并入 P09ar、P09ap）。

共享代码影响评估复盘（2026-10-20，确定性检查）：

- 每个 adapter 一条测试，断言其 parser 是否会发出 `final_text`（文档与代码一致）。
- 每个 adapter 一条环境契约测试（必需透传 / 必须拒绝）。
- 以某厂商为范围的改动若触及 `src/platform/*` 或 `src/bot/run-outcome.ts`，必须附跨 adapter 测试。
- 停止后的进程泄漏测试（进程组无残留）。
- P09ay–P09bd 由代码阅读得出，未 live 验证；除 P09ba 外均在 P09aq 绿后一批交给 Codex。

P09 E2E 发现的 won't-fix（不建票）：

- **B3 暂停→恢复后 revision ABA：** won't-fix，内容完全相同且无副作用。

P03 可通过现有已存 agent 任务验收，不依赖新创建入口。P05 能管理现有任务，不依赖 P04。P06 以内容读取和脚本使用验收，不依赖 automation 写操作。P07 需要完整能力作为共同测试对象，P08 等完整替代路径就绪后才移除旧协议。

## 共同接口与不变量

以下约定随每个实施 brief 一并提供；票正文、规格与 HANDOFF 不可只摘取一个标题后派工。

1. **客户端入口**：新增 `lark-channel-bridge tool`，从 stdin 接收一份版本化结构化请求并在 stdout 返回一份结构化结果；诊断走 stderr。提供机器可读 schema/help，不经 shell 拼接用户文本。
2. **操作名称**：插件操作为 `plugins.list`、`plugins.inspect`、`plugins.read`；automation 为 `automation.schema`、`automation.list`、`automation.preview`、`automation.create`、`automation.replace`、`automation.delete`、`automation.pause`、`automation.resume`、`automation.operation.get`。当前尚未完成或不适用的能力必须明确不可用。各名对应同一业务接口，不新增按 CLI 品牌分叉的协议。
3. **本机调用与归属**：首版薄客户端连接 bridge 绑定在回环地址上的进程内 HTTP 入口；地址和不透明运行凭据通过子进程环境提供，不写入 prompt、普通日志或任务记录。该入口与 supervisor 管理服务及 token 分离。profile、群、actor、run 类型及有效能力由服务端绑定，模型参数不能覆盖。传输隐藏在客户端/bridge tool 模块内，插件和业务不依赖 HTTP。
4. **输出与写入语义**：协议版本、结果类别、稳定错误代码和相关数据由代码定义；写操作另有调用前确定的稳定 operationId。失败、待补全、待确认、已应用、未知和执行失败明确区分。编号查询与去重按 P02 契约跨 run/重启保持一致，不能只在进程内缓存。
5. **模型与业务职责**：模型负责自然语言映射、选择 bot/user 身份、读取 skill 和根据工具反馈继续处理；代码负责 schema、校验、身份归属、业务副作用和实际状态。结构化排期直接进入已有校验/计算，不先生成自然语言时间串；不从 Markdown 提取业务程序。
6. **身份与包生命周期**：沿用当前 profile 的配置和 lark-cli 凭据，CLI 负责刷新；只使用已安装的包。run 内版本一致，固定版本目录经部署重启生效；不做热替换、自动安装、独立 token 存储或新的权限体系。
7. **验证与发布**：T1 完整业务链是主 seam，catalog 和真实 CLI process 是补充。每票先建立有意义的失败，再实现和回归；代码执行 `pnpm ci:local`。真实验证按项目环境指引，缺失证据不能用其他 CLI、mock 或截图替代。文档拆票阶段不运行这些功能测试。

## 覆盖索引

| 规格验收 | 主要交付票 | 补充证据 |
| --- | --- | --- |
| A01、A04、A05、A16 | P06 | P07、P09 |
| A02、A03 | P01、P06 | P07、P09 |
| A06、A07 | P01、P04、P07 | P09 |
| A08、A09 | P01、P02、P05 | P07、P09 |
| A10 | P02、P04、P05 | P08、P09 |
| A11、A12 | P02、P05 | P04、P07、P08、P09 |
| A13、A14 及 D8 新补充 | P03、P04 | P09 |
| A15 | P08 | P02、P09 |

## 原 Revision 2.1 票

以下正文仅供追溯，不能认领或实施。各旧票顶部 superseded 状态优先于其历史验收说明。

| 旧票 | 当前状态 | 后续处理依据 |
| --- | --- | --- |
| [B01](B01-skill-module-and-automations.md) | superseded | 按 plugin 管理、逐层发现及 automation 正常调用重新切片。 |
| [B02](B02-rejection-feedback.md) | superseded | 下一轮注入拒绝反馈改为本轮工具结果，旧队列方案不继续。 |
| [B03](B03-no-card-promise-on-rejection.md) | superseded | 真实状态回执和副作用一致性承担正确性，措辞只负责解释。 |
| [B04](B04-lark-cli-skills.md) | superseded / 原业务迁移延期 | 本次只包含 automation 所需共用基础和身份修正。 |
| [B05](B05-interactive-card-skill.md) | superseded / 延期 | 通用交互卡片说明迁移不在本次范围。 |
| [B06](B06-comment-and-meeting-skills.md) | superseded / 延期 | 评论和会议说明迁移不在本次范围。 |
| [B07](B07-e2e-three-clis.md) | superseded | 按新调用链、真实业务结果和六种 CLI 重新定义验收。 |
