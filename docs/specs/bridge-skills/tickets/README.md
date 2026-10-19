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
