# PR51 — Bridge plugins 与 automation 规格交接

Revision 3 · 2026-10-20 · Status: P09 E2E 已完成，P09a–P09m 修复实施中（见下方“当前状态（2026-10-20）”）

## 从这里开始

1. 读 [Revision 3 规格](../bridge-skills.md)：产品边界、User Stories、模块契约与验收。
2. 本文件提供代码导航和旧方案差异；实现时重新核对 checkout 与当前代码。
3. [B01–B07](tickets/README.md) 全部是 superseded 的旧票，不能认领或照旧执行。
4. [P01–P09](tickets/README.md) 是当前实施票；连同共同契约、各票正文和本导航读取。拆票已完成，代码实施尚未授权。

文档载体：[PR #51](https://github.com/Rainnystone/larkent/pull/51)，分支 `docs/bridge-skills`；保留文档专用、不合并的既有约定。用户已明确授权修订该 PR，并委托按工程判断继续 to-tickets。测试 seam 已在讨论中确认。

## 当前状态（2026-10-20，接手先读）

> 本节覆盖下文旧的“尚未授权实施”表述；下文代码导航仍可参考。时间为 UTC+8。

- **代码：** PR #52（分支 `feat/bridge-skills`）最后一次经 Codex 审阅的 head 为 `0b55865`，即 P09 验收候选。
- **P09 真实飞书 E2E：** 已完成一轮（Grok Build、Antigravity、Cursor CLI、Kimi）。发现的问题拆为 P09a–P09m，索引与依赖分组见 [tickets/README.md](tickets/README.md)（`f3c5254`）。
- **派工：** 2026-10-20 00:59 把整批票作为一条消息发给 Cursor Project cloud agent。它在 `feat/bridge-skills` 上实施，从 P09b 开始（G1 组）按依赖顺序推进，一票一会话，用 TDD 并在会话内做 code review。截至本次更新，#52 head 尚未变化（仍为 `0b55865`）。
- **实施约束：** 只推 `feat/bridge-skills`，不开新 PR，不把 `.scratch`/Spec 拷进代码分支，不 force-push；实施方**不得**发 `@codex` 或请求任何 review；仓库公开，不写入飞书 ID、人名或密钥。

### 依赖分组（详见 tickets README）

G1 P09b→P09d→P09e→P09f · G2 P09a→P09g · G3 P09k→P09j · G4 P09h→P09m · G5 P09c · G6 P09i · G7 P09l。组内串行，组间可并行。

### 为什么要修（用户可见影响）

| 票 | 级别 | 影响 |
| --- | --- | --- |
| P09a | P2 | 周期确认卡次数与实际不符（如每天一个月显示“约每月 28 次”，应为“共 31 次”） |
| P09b | P2 | 桥重启/断线后补发的真人消息被判为非人工，自动化请求全部被拒 |
| P09c | P2 | 发卡结果未知时回读对账永远绑不上卡，已送达的卡点了显示“已失效”，operation 卡在 unknown |
| P09d | P3 | `showToolCalls` 开启时工具卡暴露内部 bridge tool 命令与协议 JSON |
| P09e | P3 | 最终回复发出前用户已点卡，回复仍写“待确认”，与卡片矛盾 |
| P09f | P3 | 回复原样搬运 `waiting-confirmation`、`applied` 等机器字段 |
| P09g | P3 | 替换卡正文“将删除：#N”让人以为任务会被删掉 |
| P09h | P3 | 从未触发的任务显示“上次运行成功” |
| P09i | P3 | 补全结束日期卡最短预设一个月，一周/两周只能用自然语言 |
| P09j | P3 | 同名冲突包让合法包消失，歧义结果给出的 reference 也无法用来选择 |
| P09k | P3 | 插件目录不存在时只给未文档化的 `invalid-package` |
| P09l | P3 | Grok 工具卡把 Bash 输出显示成十进制字节数组 |
| P09m | P3 | 只读 `auth logout --help` 被误判为认证变更，任务被暂停；`auth-config` 码 agent 看不到 |

- **Won't-fix：** B3 暂停→恢复后 revision 回到原值（ABA），内容相同、无副作用。
- **实测（live）验证：** 场景 1–8 主要路径，包括场景 8 版本切换与过期 reference 拒绝；F4（拦截成立，见 P09m 误报）；F5（自动 run 内管理工具被拒、读取可用）；F7 结果为 fail（P09c）。
- **仅代码审阅、未实测：** F6（停掉活动 run 后原连接失效、已接受的操作仍可查）需要 run 连接凭据，测试者不应接触；已授权 **user 身份**路径在测试 profile 没有 user token，未登录验证（bot 身份已实测）。

### 剩余计划

1. 实施完成后确认 #52 CI 全绿。
2. 由编排方（不是实施方）在 #52 发起**限定范围**的 Codex review，只审 `0b55865..<新 head>`。
3. 分诊 review 意见：P1/P2 必须能在飞书里真实触发，才做根因修复并补测试；无法触发的记 won't-fix；P3 转为延后票。
4. 在飞书里对修复做可视化复验（卡片、回复、工具卡）。
5. 正常合并 #52（merge commit，**禁止 squash**）。
6. 部署生产 bridge，并做健康检查。
7. 在生产 Grok bridge 上做 P10 UAT。
8. 测试 bridge 继续保留，用于观察已排期的触发：10-21 11:00、10-22 15:00、10-23 10:00/11:00、10-24..26 每天 09:00，另有一个每日重复任务（均为 UTC+8）。
9. 清理测试环境，补建延后的 P3 票。

### 测试环境经验（通用）

- 桌面飞书客户端点卡返回 403，网页客户端（和手机）点击能到达 bridge；这是环境问题，不是 bug。
- 卡片点击只有在发卡的那个 profile 正在运行时才生效；否则日志为 `cardAction skip-auto-unregistered`，toast 显示“此确认已失效”。
- 切换 profile 或重启 bridge 会触发 backfill 重放历史消息（各 profile 的 ledger 分开，可能重复处理）。
- 测试 profile 为调试开启了 `showToolCalls`，生产默认关闭。
- Grok 额度留给 UAT，E2E 优先用 Kimi。

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
