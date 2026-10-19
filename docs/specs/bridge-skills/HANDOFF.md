# Handoff: bridge skill module（共享 skill 池 + 原子 bridge 工具；tickets B01–B07）

给**没有任何前情**的读者（Codex、Cursor 或任何 CLI agent，也给做设计评审的人）。本文自包含：读完就能理解要做什么、为什么、怎么设计、哪些已定、哪些是风险，以及我们希望你反馈什么。需要细节时按顺序读：

1. 本文；
2. `docs/specs/bridge-skills.md`（Spec：问题、方案、user stories、D1–D10 设计、测试、Decisions）；
3. `docs/specs/bridge-skills/tickets/README.md`（ticket 表、顺序、阻塞图）；
4. 要实现时，只读分给你的**那一个** ticket：`docs/specs/bridge-skills/tickets/B0N-*.md`。

这些文件**只在**分支 `docs/bridge-skills` 上（draft docs PR [#51](https://github.com/Rainnystone/larkent/pull/51)，永不合并）。只读方式：

```bash
git fetch origin docs/bridge-skills
git show origin/docs/bridge-skills:docs/specs/bridge-skills/HANDOFF.md
git show origin/docs/bridge-skills:docs/specs/bridge-skills.md
git show origin/docs/bridge-skills:docs/specs/bridge-skills/tickets/README.md
git show origin/docs/bridge-skills:docs/specs/bridge-skills/tickets/B01-skill-module-and-automations.md
```

**不要把这些文件复制进代码分支。**

## Method

mattpocock skills，https://github.com/mattpocock/skills：`to-spec` / `to-tickets` 产出本轨道；模块设计用 `codebase-design`（deep module、interface、seam、adapter、leverage、locality、deletion test、design it twice）和 `improve-codebase-architecture`（按 git 热点找 deepening 机会）；每份 `SKILL.md` 按 `writing-for-agents`（含 `SKILL-MECHANICS.md`）写。参考实现：Pi agent framework 的 skills（[docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)，实现的是 Agent Skills 规范：上下文里只放 name / description / path，任务命中时模型自己读 `SKILL.md`）。

实现阶段用 `implement`（驱动 `tdd`），最后 `code-review`。你的 agent 没有这些 skill 时，按下面的规则做，是同一套纪律。

## 这是什么

Larkent 是把飞书 / Lark bot 桥接到本地 CLI coding agent 的 bridge（公开仓库 `Rainnystone/larkent`）。同一套 bridge 代码驱动 6 种 agent kind：Claude Code、Codex CLI、Kimi Code、Grok Build、Cursor CLI、Antigravity CLI。每个 profile = 一个飞书 bot + 一个 agent。

bridge 除了转发消息，自己还提供一些**原生能力**：用自然语言建定时任务（automations：模型在回复里写 `<automation_proposal>` 块 → bridge 校验 → 群里出确认卡）、签名回调卡片、代发云文档评论回复和会议回答、bridge 绑定好的 `lark-cli` 环境。模型得知道这些能力何时可用、怎么用。

本项目要做的是一个**独立的 bridge skill 模块**：一个所有被桥接 agent 共用的 **skill 池**，加上一组原子的 **bridge 工具**。bridge 每轮告诉模型「本轮有哪些 skill、各自何时适用、全文在哪」，模型按需读、自己决定调用哪些工具。automations 是接入的第一个 skill。

## 为什么（具体问题）

1. **模型不会用 bridge 工具。** 2026-10-19 线上（一个真实群，Grok Build profile）：用户要每天提醒，模型连续三次写 `every 1d 09:00 until …`，三次都被 bridge 以 `invalid-schedule` 拒绝。语法里 `every` 只接受分钟 / 小时，每天要写 `每天 09:00 until <日期>`；而教模型的那段说明只有 `every 30m` 一类例子，没有「每天 / 每周 / 工作日」的完整写法，也没有「被拒后怎么改」。模型下一轮也拿不到机器可用的拒绝原因（resume 的会话转录里只有模型自己的输出，bridge 追加在群里的那行拒绝提示进不了它的上下文），所以同样的错连犯三次。同一条回复里模型还承诺「我给你发确认卡」，而 bridge 末尾那行写的是「没有创建任务」。
2. **说明是硬编码字符串，散在 8 个文件里，且不门控。** automations 说明约 1.5k 字，开启后每轮整段注入（p2p 也注入，然后提案被「仅支持群」拒绝）；一段 lark-cli 环境说明每轮注入，又和 system prompt 里的同一段重复；system prompt（6 种 agent 共用）里混着交互卡片回调、lark-cli 身份规则、OAuth 授权流程这些操作手册，无人值守的定时 run 只好再加一段「忽略上文身份规则和 OAuth 整节」去抵消；评论和会议 prompt 里也各有一段规则文字。改一处漏一处，看不出到底注入了什么，教学效果也无法测试。
3. **`~/.agents/skills` 不合适。** 它是三种 CLI 唯一共同读取的原生 skill 目录，但它是全局的：同一主机上所有 bot、以及 bridge 之外的 CLI 会话都会看到，没有按 bot / 按轮的门控；要在每台主机单独安装，会和已装 bridge 版本漂移；依赖各 CLI 的 loader 行为（Grok 的项目级 skill 还要 `--trust`，bridge 不传）。

## 怎么设计

**术语**：skill = 一份 `SKILL.md`，写「何时适用、怎么组合工具」；bridge 工具 = 原子、机械、可组合的能力，硬约束在它的代码里；catalog = 每轮注入的 skill 清单；turn context = 判定门控用的本轮上下文；bridge 契约 = 每个分支都要的约定（留在 system prompt）；本轮事实 = 只在本轮成立的状态数据。

1. **模块：一个 deep module，两个入口。** 都接收 turn context（profile 配置、run 种类 `im` / `auto` / `meeting` / `comment`、chat 类型、触发者是人还是 bot）：
   - **list catalog** → 本轮可见 skill 的 `{ name, description, SKILL.md 绝对路径, 本轮不可用的可选工具 }`；
   - **read skill** → 某个 skill 全文；被门控时为空（拒绝反馈按 reason code 取修正条目、测试、将来给 agent 的读命令都走它）。
   纯读、无副作用、结果确定；坏掉的 skill 不可见并打 warn，不影响其它。藏在接口后面的：skill 根目录定位（源码与 `dist` 都对）、扫描与缓存、frontmatter 解析、工具可用性判定、绝对路径。skill 根目录是注入的依赖（生产 = 随包发布的目录，测试 = fixture 目录，两个 adapter，所以是真 seam）。不做插件系统、不做可替换渲染器。
2. **SKILL.md 格式**（Agent Skills 规范最小子集）：每个 skill 一个目录，目录名 = `name`；frontmatter 必填 `name`、`description`（context pointer：领先词开头、每个分支一个触发，≤ 200 字符），可选 `metadata.bridge-tools`（必需工具，缺一个就不可见）和 `metadata.bridge-tools-optional`（不可用时 catalog 注明）。正文中文为主，工具名、reason code、命令原样英文。skill 根目录不放在任何 CLI 会自动加载的目录下（`.agents/`、`.cursor/`、`.claude/`、`.codex/`、`.grok/`）。
3. **工具与门控。** 每个 bridge 工具 = 名字 + `available(turn context)` 谓词 + 执行 / 校验代码。**catalog 门控与 bridge 结算时「是否接受这次调用」用同一个谓词**，改一次两处一起变。v1 工具：`automation-proposal`（开启 automations、群聊、人工 IM run、人类触发）、`automation-agent-task`（再加 `agentTasks` 开）、`lark-cli`（所有 run）、`lark-cli-user`（人工 IM run）、`card-callback`（人工 IM run）、`comment-reply`（评论 run）、`meeting-reply`（会议 run）。bot 永远看不到它缺工具的 skill。
4. **catalog 放在用户输入之前。** 每轮作为 user message 的**第一个** section 放一个 `<bridge_skills>` 块（在 `bridge_context`、本轮事实、引用上下文和 `user_input` 之前）：一行引导 + 每个 skill 一到两行（触发条件 + 绝对路径）。理由：catalog 对同一 bot、同一 run 种类基本不变，Cursor / Antigravity / Kimi / Codex 的 system prompt 又正好前置在 user message 开头，两者连成稳定前缀，对 prompt cache 友好。路径必须绝对，因为 agent 的 cwd 是 per-profile bridge 工作区，不是包目录。块有字符预算，不内联硬规则。示意：

   ```
   <bridge_skills>
   以下 skill 本轮可用。请求符合某条时，先用读文件工具读它的 SKILL.md 全文，再按其中写法调用 bridge 工具；未列出的能力本轮不可用。
   - automations：<description>（本轮不可用：automation-agent-task）
     /abs/path/to/automations/SKILL.md
   </bridge_skills>
   ```

5. **加一个 skill**：纯指导 skill = 加一个目录，不改代码；需要新工具时，在工具所属模块实现执行与校验、在工具表加一项、结算路径用同一谓词。contract test 自动覆盖新 skill（frontmatter、工具名、预算、打包、路径存在）。
6. **迁什么、留什么**（Spec D7 有逐项清单）：
   - **迁成 skill**：automations 说明 → `automations`；每轮 lark-cli 块 + system prompt 的 lark-cli 环境 → `lark-cli`；身份规则 + OAuth → `lark-user-identity`（只在人工 run 可见，定时 run 的「忽略上文」随之消失）；卡片回调约定 → `interactive-card`；评论读取与回复格式 → `doc-comment`；会议回答要求 → `meeting-reply`。
   - **留作 bridge 契约**（system prompt）：`bridge_context` 含义、bot-at-bot、最终回复由 bridge 发、引用 / 卡片输入格式、身份行、定时 run 的 bot-only 与禁止项，以及一句 `<bridge_skills>` 的含义。
   - **留作本轮事实**：中断续跑 / 放弃、模型切换、离线补处理、补跑、`<group_automations>` 快照、拒绝反馈。
   迁移是行为等价搬家，措辞改动单独成票。
7. **automations 作为第一个实例**：完整时间表语法（明确 `every 1d` 无效 → `每天 HH:MM until …`）、每个 reason code 一条修正条目（contract test 从类型穷举）、示例都能被同一解析器解析（测试保证）、定时 agent 任务只用 bot 身份（不得 `--as user`，`user-identity` 暂停的修法）。被拒时 bridge 记下 reason code，下一轮作为本轮事实注入 `<bridge_tool_rejected>`，修正文字用 **read skill** 从 `SKILL.md` 取，用一次即清；bridge 的拒绝行写明「未生成确认卡」，skill 的回复措辞不再预告确认卡。
8. **安全在工具里，不在模型行为里。** 解析器、上下限、群聊限制、编号归属、只认人类消息、确认卡和 `bridge_token` 签名、policy-guard、lark-cli bridge-bound 模式是唯一裁决。skill 只影响模型写得对不对，不影响能不能生效；catalog 缺失、文件读不到、模型乱写，结果只是被拒或被忽略。

## 否决的备选

| 方案 | 否决理由 |
|---|---|
| 把 skill 装进 `~/.agents/skills` 或各 CLI 原生 skill 目录 | 全局、无门控；每台主机要安装且与版本漂移；依赖各 CLI loader；Grok 项目级要 `--trust` |
| 代码注册表：每个 skill 一项 `{name, available, docPath}` | 浅模块；门控谓词与工具校验分两处（两份真相）；加纯指导 skill 也要改代码 |
| 只给 agent 一个「列 / 读 skill」的 CLI 命令，不给路径 | 多一个面向 agent 的进程边界，沙箱 / PATH 更难保证；保留为扩展点（某种 agent 读不了绝对路径时再做） |
| 继续用硬编码长说明，只补例子 | 不可门控、不可测、没有渐进披露，下一个工具又要再塞一段 |
| 扩解析器支持 `every 1d` | 为模型的错误扩语法；教对现有语法即可 |
| 被拒后自动发起重试 run | 多一次无人触发的 run；下一轮注入拒绝反馈足够 |
| catalog 放在用户输入之后 | 破坏稳定前缀，对 prompt cache 不友好 |

## 已锁定的决定

用户 2026-10-19 确认（Spec「Decisions」一节是原文）：

- **Q1** skill 在仓库内、随包发布，bridge 每轮注入 catalog；不用 CLI 原生 skill 目录，不给 Grok 传 `--trust`。
- **Q2** 门控按工具可用性；automations 只在群聊可见。
- **Q3** 被拒不自动重试，下一轮注入拒绝反馈。
- **Q4** 不扩工具语法（不支持 `every 1d`）。
- **Q5** catalog 不内联硬规则。
- **Q6** agent 按绝对路径自己读 `SKILL.md`；E2E 验证；某种 agent 读不到再给它加读命令。
- **Q7** 正文中文 + 英文标识符。
- **Q8** 拒绝反馈存内存、按 scope、用一次即清。
- **N1** 本轮事实不做成 skill。**N2** bridge 契约不做成 skill，只迁操作手册。**N3** catalog 放在用户输入之前（第一个 section）。**N4** 必用的 skill（评论、会议）也只给 catalog，E2E 看读取率再说。**N5** 第一版不加 per-profile skill 开关。**N6** 「靠模型自觉」的禁止项（群里 OAuth、unset 环境变量）以后由工具强制，另开票。**N7** `lark-cli` skill 只保留与 agent kind 无关的事实。
- 模块第一版只有两个入口（list catalog / read skill）；奥卡姆剃刀，扩展点只留 seam。

## 未决风险

- **模型不去读 skill。** 渐进披露靠模型自觉；读取率低时 skill 等于没有。缓解：description 写成强 context pointer；B07 逐个 agent kind 记录读取率；评论 / 会议这类必用 skill 留有「全文内联」扩展点。
- **某种 CLI 读不了 cwd 之外的绝对路径**（沙箱、访问模式）。B07 验证；读不到就给它加包装 read skill 的命令。
- **system prompt 变短后的行为回归。** 迁走的段落以前对所有 run 都在；迁成 skill 后只在门控允许时可见，且需要模型去读。B04–B06 要求逐条短语的 contract test，B07 做跨 CLI 人工验收。
- **部署产物缺 skill 文件**（只打了 JS）。B01 有打包检查和部署后路径存在的检查。
- **「同一谓词」重构的爆炸半径**：门控与结算共用谓词需要动结算路径；B01 要求现有自然语言建 / 删 / 改任务的集成测试全部保持绿色。
- **共享文件冲突**：B02–B05 逻辑上只依赖 B01，但共改结算路径、prompt 拼装和 system prompt，所以在共享分支上串行。
- **安全仍有靠模型自觉的地方**：群里发起 OAuth、unset `LARK_CHANNEL` 目前只写在说明里（N6 另开票）。policy-guard 是纵深防御，不是安全边界：agent 仍有完整 shell。

## 当前状态

- `master` @ `953e7bd`（automations 已合入）。还没有任何 skill 模块代码。
- 代码分支 `feat/bridge-skills`（从 `origin/master` 建；不存在就由 B01 创建），共享一个 code PR，只放代码，尚未开。
- 文档分支 `docs/bridge-skills`，draft docs PR #51：Spec、tickets、本文。永不合并。

## Inventory（`master` @ 953e7bd）

| 位置 | 相关性 |
|---|---|
| `src/automations/proposal.ts` | `AUTOMATION_PROPOSAL_INSTRUCTION`（迁成 `automations` skill 后删除）；`shouldHonorAutomationProposal`（结算谓词，门控复用它） |
| `src/automations/command.ts`、`schedule.ts` | 时间表解析器与 reason code（skill 语法与修正条目的真相来源） |
| `src/bot/channel.ts` | IM run 的 prompt 拼装（`extraInstructions`）、`BRIDGE_AGENT_INSTRUCTIONS`、提案结算路径 |
| `src/agent/prompt.ts` | `buildAgentPrompt` 的 section 顺序（catalog 放在最前） |
| `src/agent/bridge-system-prompt.ts` | 6 种 agent 共用的 system prompt 与 automation 变体附加段 |
| `src/automations/agent-run.ts` | 定时 agent 任务的 prompt |
| `src/bot/comments.ts`、`src/meeting/orchestrator.ts` | 评论、会议 prompt builder |
| `package.json` `files`、`tsup.config.ts` | 打包：skill 根目录要进发布包 |
| `CONTEXT.md` | 领域词表；新词（Spec D10）在代码 PR 里加入 |

## Tickets 与顺序

| # | Ticket | Blocked by |
|---|---|---|
| B01 | Tracer：skill 模块 + IM 轮 catalog + `automations` 作为第一个 skill 迁入，随包发布 | — |
| B02 | automations：reason code + 下一轮拒绝反馈 | B01 |
| B03 | automations：「未生成确认卡」、按类型给建议、措辞不提确认卡 | B01 |
| B04 | `lark-cli` + `lark-user-identity`；catalog 接到定时任务 / 评论 / 会议 prompt | B01 |
| B05 | `interactive-card` | B01 |
| B06 | `doc-comment` + `meeting-reply`；清单收口 | B01, B04 |
| B07 | Grok Build / Antigravity CLI / Cursor CLI 上 E2E（ready-for-human） | B01–B06 |

执行顺序：**B01 → B02 → B03 → B04 → B05 → B06 → B07**，串行。一个 ticket = 一个新会话。

## Testing discipline

- 红 → 绿 → 重构。**每个 ticket 先写一个失败的测试**，断言外部行为：agent 收到的 prompt（`FakeAgentAdapter` 的 run options）、群里看到的消息 / 卡片（recording channel）、模块两个入口的返回值，不断言内部调用。
- 最高 seam：`startChannel` 集成测试（prior art：`tests/integration/bot/auto-nl-creation.test.ts`、`auto-proposal-reply.test.ts`、`auto-nl-delete-replace.test.ts`）。模块测试用临时 fixture skill 根目录。
- skill contract test 和 prompt section guard test（每个 section 标注 契约 / 本轮事实 / catalog，并断言 catalog 在最前）对所有 skill 自动生效。
- Replace, don't layer：对旧硬编码文字的断言迁到 `SKILL.md` 上，然后删掉旧断言。
- 结束前 `pnpm ci:local` 在你的 worktree 通过；主机内存紧张时只跑改动相关的测试文件，CI 跑全量。
- 跨 CLI 的真实 E2E（B07）由 operator 在测试 bridge 上做，不由 agent 做。

## Workflow rules（双轨）

- **docs PR**（#51，`docs/bridge-skills`）只放 Spec / tickets / 本文，永不合并；**code PR** 只放代码，分支 **`feat/bridge-skills`**。
- 一个会话一个 ticket；不顺手做下一个，不合并多个 ticket。
- 认领：取串行顺序里第一个「阻塞项都已在 `feat/bridge-skills` 上完成、且没人认领」的 ticket，在 PR #51 评论 `claiming Bxx`，然后只读地读 ticket；完成后评论 `done Bxx @ <sha>`。ticket 有问题就停下，在 #51 评论说明；Spec / ticket 只在 docs 分支上改。
- `git fetch origin && git checkout feat/bridge-skills && git pull`。只推 `feat/bridge-skills`。普通提交；**不 force-push、不 squash、不 rebase 已推送的提交、不另开 PR**。
- 不把 code PR 标成 ready、不请求 review、不合并、不部署。
- **公开仓库**：不得写入任何 Feishu ID（必要时只留末 4 位）、账号名 / bot 名、token、密钥。

## Review and merge

- review：每次请求做一轮增量 review，只看新提交；operator 统一判断发现，只把成立的派成同一代码分支上的后续工作。
- merge：review 通过、CI 绿后由人以**普通 merge（不 squash）**合入 code PR；docs PR 保持 draft 或关闭不合并。

## 希望评审者反馈的问题

和 Codex 讨论这个想法时，我们最想听到：

1. **边界划分**：skill 与 bridge 工具的分界、「契约 / 本轮事实 / skill」三分法，有没有放错类的条目（Spec D7）？
2. **接口是否够小、够深**：两个入口 + 注入的 skill 根目录是否足够？有没有该藏起来却漏到调用方的东西，或者为了扩展点提前加的浮肿？
3. **门控谓词与结算谓词共用**，在 Codex 看来是否合理、有没有反例？
4. **渐进披露的可靠性**：按你对 Codex CLI 的了解，模型会不会按 catalog 去读 `SKILL.md`？description 怎么写更容易命中？必用的 skill 是否应直接内联？
5. **catalog 放在用户输入之前**：对 Codex 的 prompt 缓存和指令遵循有没有副作用？
6. **Agent Skills 兼容性**：frontmatter 用 `metadata.bridge-tools` 声明工具，是否和 Codex / 其它实现的 skill 习惯冲突？
7. **安全**：还有哪些规则现在只靠模型自觉、应该搬进工具代码？
8. **ticket 切片**：B01 作为 tracer 是否太大？B02–B06 的拆分和串行顺序是否合适？

## Report back（每个 ticket）

- code PR head SHA。
- `pnpm ci:local`（或改动相关测试文件）的输出与测试数；code PR 上的 CI 状态。
- `git diff --stat origin/master...HEAD`，以及本 ticket 动到的每个文件一行说明。
- 遗留风险 / 跳过的内容及原因。
