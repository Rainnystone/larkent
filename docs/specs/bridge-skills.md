# Spec: Bridge skills（所有桥接 agent 共用的 skill 池 + 原子 bridge 工具）

Status: ready-for-agent · Docs track: PR #51（branch `docs/bridge-skills`，本 PR，never merged）· Code track: branch `feat/bridge-skills`（from `origin/master`；one shared code PR，code only）
Tickets: [`bridge-skills/tickets/`](bridge-skills/tickets/README.md)
Baseline: `master@953e7bd`（PR #49 automations 已合入）。本文只写行为、决策、边界与验收；代码锚点（file:line，已对 `953e7bd` 核对）写在各 ticket。
Method: [mattpocock/skills](https://github.com/mattpocock/skills) `to-spec` → `to-tickets`；模块设计用同仓库 `codebase-design`（deep module / interface / seam / adapter / leverage / locality、deletion test、design it twice）与 `improve-codebase-architecture`（按热点找 deepening 机会）；SKILL.md 写法遵循 `writing-for-agents`（含 `SKILL-MECHANICS.md`）。参考实现：Pi agent framework 的 skills（启动时只把 name / description / path 放进上下文，命中时模型自己读 `SKILL.md`）。
Revision 2（2026-10-19）：上一版只覆盖 automations，读起来像 automations 的一个功能。本版把 bridge skill 做成独立模块，automations 是接入的第一个 skill。

---

## Problem Statement

bridge 往 agent prompt 里自动注入的「怎么做」的文字，散落在代码各处的硬编码字符串里，并且每个 bot、每一轮都整段注入：

- **automations**：`AUTOMATION_PROPOSAL_INSTRUCTION`（约 1.5k 字）在 `automations.enabled` 时每轮追加。
- **每轮 IM 指令**：`BRIDGE_AGENT_INSTRUCTIONS`（lark-cli bridge-bound 环境 4 行），和 system prompt 里的同一段内容重复。
- **system prompt**（6 种 agent kind 共用：Grok 走 `--rules`，Claude 走 system prompt 文件，Cursor / Antigravity / Kimi / Codex 前置到每条 prompt）：除了 bridge 契约本身，还有交互卡片回调约定、lark-cli 身份规则、OAuth 授权流程这几段操作手册。自动化 run 还要再加一段「忽略上文身份规则和 OAuth 整节」来抵消它们。
- **云文档评论 / 会议**：评论 prompt 里有读取命令和回复格式要求，会议 prompt 里有回答长度和格式要求，都写在各自的 prompt builder 里。

后果：

1. **不可管理**：同一条规则改一处漏一处（lark-cli 环境说明有两份）；新增一个 bridge 能力就得往 prompt 里再塞一段长句，看不出当前到底注入了什么。
2. **不可门控**：bot 会看到它当前用不上的能力的说明。自动化 run 只能靠一段「忽略上文」去抵消；p2p 也会注入 automations 说明，然后提案被「仅支持群」拒绝。
3. **没有渐进披露**：不管用不用，每轮都付全部 context load。
4. **教学效果无法测试**：2026-10-19 线上证据（一个真实群，Grok Build profile）：
   - 模型连续三次写 `every 1d ...`，三次都被 bridge 以 `invalid-schedule` 拒绝。`every` 只接受分钟 / 小时，说明里没有 `每天` / `每周` / `每个工作日` 的完整写法，也没有「被拒后怎么改」的映射；模型下一轮也拿不到机器可用的拒绝原因（resume 的会话转录里只有模型自己的输出）。
   - 模型正文承诺「我给你发确认卡」，而同一条回复末尾 bridge 写的是「没有创建任务」。

## Solution

在 bridge 里建一个独立的 **bridge skill 模块**：一个 **skill 池**，加上一组原子的 **bridge 工具**，所有被桥接的 agent bot（Grok Build、Antigravity CLI、Cursor CLI，以及 Claude / Codex / Kimi 和以后接入的）共用。

- **Skill** = 一个目录里的一份 `SKILL.md`（frontmatter `name` / `description`，正文写何时用、怎么组合工具、示例、出错怎么改）。只描述「何时适用、如何组合工具」，不含硬约束。可以搭配 bridge 工具（automations），也可以是纯指导（例如以后的 coding skill）。
- **Bridge 工具** = 原子、机械、可组合的能力：一条命令、一个脚本、或 bridge 原生动作（提议 / 创建 / 删除定时任务、发 / 更新卡片、回复评论）。硬约束、权限、校验全部在工具 / bridge 代码里，从不依赖模型是否照做。
- **每轮 catalog**：bridge 在用户 prompt 之后追加一个 **skill catalog**，每个当前可见的 skill 一到两行（触发条件 + `SKILL.md` 的绝对路径）。模型只在适用时用自己的读文件工具读全文（渐进披露），再自主决定调用哪些 bridge 工具。
- **门控**：skill 声明它依赖的 bridge 工具；工具是否可用由代码按 profile 配置和本轮上下文判定。bot 永远看不到它缺工具的 skill。
- **最小接口**：模块第一版只有两个入口：列出 catalog、读取某个 skill 全文。扩展点（更多 skill 根目录、给读不了路径的 agent 一个读 skill 的命令）留好 seam，不预先实现。
- **automations 是第一个接入的 skill**：`AUTOMATION_PROPOSAL_INSTRUCTION` 迁移成 `automations` skill，顺带修好上面的线上问题（完整语法、按 reason code 的修正条目、下一轮的拒绝反馈、拒绝时不承诺确认卡）。之后把其余操作手册类注入（lark-cli、交互卡片、OAuth、评论、会议）逐个迁成 skill；最后 skill 系统之外只剩 bridge 契约和本轮事实（D7 清单）。

## User Stories

Skill 模块（通用）

1. As a bot owner, I want every piece of how-to text the bridge injects to live in one `SKILL.md` per skill, so that I can see and edit what my bots are taught in one place.
2. As a bot owner, I want my bot to see only skills whose bridge tools it actually has this turn, so that disabled features stay invisible and are never proposed.
3. As a bot owner, I want unattended `auto:` / `meeting:` runs to see only the skills that apply to them, so that the system prompt no longer needs an "ignore the section above" addendum.
4. As a bot owner, I want the per-turn overhead to be a short catalog (one or two lines per visible skill), so that every turn costs fewer tokens than today's full instructions.
5. As a bot owner running Grok Build, I want skills to work without passing `--trust`, so that the bridge does not widen Grok's project trust.
6. As a bot owner running Antigravity CLI or Cursor CLI, I want skills to work without any per-host skill install, so that a fresh host works after `start`.
7. As a bot owner, I want skill docs to ship inside the deployed package and match the installed bridge version, so that docs and tool behaviour cannot drift.
8. As a bot owner, I want the bridge's tool validation to stay authoritative whatever the model read, so that a model that skipped a skill can still never do something invalid.
9. As a model, I want a compact catalog that tells me which skills exist this turn, when each applies, and where its full text is, so that I read a skill only when the request needs it.
10. As a model, I want each skill to tell me when it applies and how to compose the bridge tools it pairs with, so that I can decide on my own which tool to call.
11. As a model, I want catalog paths to be absolute, so that I can read them from the per-profile bridge workspace I run in.
12. As a model, I want the catalog to tell me which of a skill's optional tools are off this turn (for example agent tasks), so that I do not propose something the bridge will refuse.
13. As a maintainer, I want to add a pure-guidance skill by adding one directory with a `SKILL.md`, with no code change, so that the pool grows cheaply.
14. As a maintainer, I want to add a tool-backed skill by adding the `SKILL.md` plus one bridge tool (its availability predicate and validation in code), so that the gate and the enforcement come from the same predicate.
15. As a maintainer, I want a contract test that fails when a skill has bad frontmatter, names an unknown bridge tool, has a description over budget, or is missing from the built package, so that a broken skill cannot ship.
16. As a maintainer, I want the module's interface to be just "list the catalog" and "read a skill", so that callers (IM turns, comment runs, meeting runs, rejection feedback, tests) all use one small surface.
17. As a maintainer, I want one guard test that lists every prompt section the bridge injects and classifies it as contract, turn fact or skill catalog, so that new hard-coded how-to text cannot creep back.
18. As a maintainer, I want the module to have a seam for extra skill roots and an agent-facing read command later, so that per-profile skills or agents that cannot read files can be added without changing callers.

Automations（第一个 skill）

19. As a group member, I want to say “每天 9 点提醒我写日报，到年底”, so that the bot proposes `每天 09:00 until <年底>` and I get a confirm card on the first try.
20. As a group member, I want weekly and workday schedules (“每周一三五 10:00”, “工作日 9:00”) to be written correctly by the bot, so that I don't have to learn the grammar.
21. As a group member, I want “每 2 小时” to become `every 2h`, and “每天” never to become `every 1d`, so that interval and daily schedules are not confused.
22. As a group member, when a proposal is rejected, I want the bot's next try to fix the specific problem the bridge named, so that I don't watch the same mistake three times.
23. As a group member, I want the bot's text to never promise a confirm card that then does not appear, and the bridge line to say plainly that no card was generated, so that I can trust the outcome.
24. As a group member, I want rejection suggestions that match the kind of schedule I asked for, so that a daily request is not answered with only one-shot examples.
25. As a bot owner, I want agent-task proposals taught as unavailable when `automations.agentTasks` is off, so that the bot proposes reminders instead of getting refused.
26. As a bot owner, I want the automations skill to say scheduled agent tasks run with bot identity only (never `--as user`) and how to fix a `user-identity` pause, so that tasks do not get paused by policy-guard.
27. As a bot owner, I want p2p chats not to see the automations skill, so that the bot never proposes something the bridge refuses in p2p.
28. As a maintainer, I want a test that fails when the bridge can produce a rejection reason the skill has no recovery entry for, and a test that every schedule example in the skill parses, so that the skill stays complete and truthful.
29. As a maintainer, I want rejection reason codes to be stable strings shared by logs, feedback and skill, so that one vocabulary serves humans, models and tests.
30. As a group member, I want group task snapshots (`<group_automations>`) to keep working unchanged, so that delete / replace by id is unaffected.

## Implementation Decisions

### D1. 模块：一个 deep module，两个入口

术语（`codebase-design` 词汇，原样使用）：**module / interface / seam / adapter / depth / leverage / locality**。领域新词见 D10。

**Bridge skill 模块** 的 interface 只有两个入口，调用方都传入同一个 **turn context**（profile 配置、scope 与 run 种类 `im` / `auto` / `meeting` / `comment`、chat 类型、触发者是人还是 bot）：

- **list catalog**：给定 turn context，返回本轮可见 skill 的条目（`name`、`description`、`SKILL.md` 绝对路径、该 skill 的可选工具里本轮不可用的那些）。条目按 name 稳定排序。
- **read skill**：给定 turn context 和 name，返回该 skill 全文；skill 本轮不可见（被门控）时返回空。B02 的拒绝反馈按 reason code 取修正条目、测试、以及将来给 agent 用的读命令都走这个入口。

interface 里还包括这些调用方必须知道的事实（`codebase-design`：interface 不只是类型签名）：

- 纯读取，无副作用；同一 turn context 结果确定。
- 门控在模块内部完成，调用方不做第二次过滤。
- skill 文件损坏（frontmatter 缺字段、引用未知工具）时，该 skill 不可见并打一条 warn 日志，不影响其它 skill，也不让 run 失败；contract test 保证这种 skill 发不出去。

模块内部藏起来的（调用方看不到）：skill 根目录的定位（源码运行与构建产物运行都正确）、目录扫描与缓存、frontmatter 解析、工具可用性判定、绝对路径解析。

**Deletion test**：删掉这个模块，路径解析、frontmatter 解析、门控条件、catalog 拼装会重新散落到 IM 主路径、评论、会议、拒绝反馈和测试里，正是今天的样子（`improve-codebase-architecture` 按 git 热点看，IM 主路径文件在最近 40 次提交里有 16 次改动，注入文字散在 8 个文件），所以它值得存在。

**Seams**：

- **外部 seam**：上面两个入口。调用方和测试走同一个 seam（the interface is the test surface）。
- **skill 根目录**是依赖注入的（dependency category 2：local-substitutable，文件系统）。生产 adapter = 随包发布的根目录，测试 adapter = 临时 fixture 目录。两个 adapter，所以是真 seam。以后的 per-profile skill 根目录也挂在这里，不改接口。
- **bridge 工具可用性表**是内部 seam：模块自带，测试通过 turn context 驱动，不对外暴露。
- 不加的 seam：不做插件系统、不做「可替换的 catalog 渲染器」（只有一个 adapter，是假 seam）。

### D2. SKILL.md 格式

遵循 Agent Skills 规范（Pi 实现的同一规范）的最小子集：

- 每个 skill 一个目录，入口 `SKILL.md`，目录名 = `name`（小写字母、数字、连字符）。可以带同目录的附件（参考文档、脚本），正文用相对路径引用，模型从 `SKILL.md` 的位置解析。
- frontmatter 必填 `name`、`description`；可选 `metadata` 里的两个键：
  - `bridge-tools`：必需的 bridge 工具名（空格分隔）；任一不可用，skill 本轮不可见。纯指导 skill 不写。
  - `bridge-tools-optional`：可选工具名；不可用时 skill 仍可见，catalog 条目注明它们本轮不可用。
- `description` 是 context pointer（`writing-for-agents`）：领先词开头，每个分支一个触发，写「何时读」，不复述正文规则；预算 ≤ 200 字符（catalog 预算见 D4）。
- 正文写法遵循 `writing-for-agents`：正向表述、领先词、同一概念的定义 / 规则 / 注意事项放同一节、单一事实来源。正文中文为主，工具名、reason code、命令原样英文。
- 不使用 `disable-model-invocation`（catalog 只列模型可自主调用的 skill）。

### D3. Bridge 工具与门控

**bridge 工具**是代码里的一项：名字 + `available(turn context)` 谓词 + 执行 / 校验逻辑（在它原来所在的模块里，本模块不搬代码）。工具种类：

- **回复指令**：模型在回复里写结构化块，bridge 结算时解析、校验、执行（`automation-proposal`）。
- **CLI 命令**：bridge 注入环境后模型直接跑的命令（`lark-cli`、`lark-cli-user`）。
- **bridge 原生能力**：签名回调卡片（`card-callback`）、bridge 代发的评论回复 / 会议回答（`comment-reply`、`meeting-reply`）。

规则：

- **同一个谓词，两处用**：catalog 门控与 bridge 结算时「是否接受这个工具调用」用同一个可用性谓词（locality：改一次，门控与执行一起变）。今天两处条件不一致的，以结算侧为准，门控跟随。
- 门控只看已有配置和本轮上下文，第一版不新增 profile 字段（per-profile 显式开关见 Open question N5）。
- v1 工具表（随 ticket 逐步加入）：

| 工具 | 可用条件 | 首个使用者 |
|---|---|---|
| `automation-proposal` | `automations.enabled`、群聊、run 种类 `im`、触发者是人 | B01 `automations` |
| `automation-agent-task` | 上一条成立且 `automations.agentTasks` 开 | B01（optional） |
| `lark-cli` | 所有 run | B04 `lark-cli` |
| `lark-cli-user` | run 种类 `im`（人工对话） | B04 `lark-user-identity` |
| `card-callback` | run 种类 `im` | B05 `interactive-card` |
| `comment-reply` | run 种类 `comment` | B06 `doc-comment` |
| `meeting-reply` | run 种类 `meeting` | B06 `meeting-reply` |

### D4. Catalog 注入

- 每轮在 **用户输入之后** 追加一个 `<bridge_skills>` 块（由同一段渲染代码产出；B01 先接 IM turn，B04 把它接到 agent 任务、评论、会议这几个 prompt builder，因为 `lark-cli` skill 迁出 system prompt 后所有 run 都要靠 catalog 找到它）。没有可见 skill 时不出块。
- 块的形状（一行引导 + 每个 skill 一到两行）：

  ```
  <bridge_skills>
  以下 skill 本轮可用。请求符合某条时，先用读文件工具读它的 SKILL.md 全文，再按其中写法调用 bridge 工具；未列出的能力本轮不可用。
  - automations：<description>（本轮不可用：automation-agent-task）
    /abs/path/to/automations/SKILL.md
  </bridge_skills>
  ```

- 路径一律绝对路径：agent CLI 的 cwd 是 per-profile bridge 工作区，不是包目录。
- 预算：整个块 ≤ 300 字符 + 每个 skill ≤ 300 字符（测试断言）。catalog 不内联硬规则（Q5），硬规则由工具校验和 bridge 结果行兜底。
- `<group_automations>` 快照照旧：它是本轮事实（数据），不是 skill；仍只在 `automation-proposal` 可用时注入。

### D5. 怎么加一个新 skill

1. 在 skill 根目录加 `<name>/SKILL.md`（D2 格式）。纯指导 skill 到此为止，不改代码。
2. 需要新的 bridge 工具时：在工具所属模块实现执行与校验，在工具表加一项（名字 + 可用性谓词），并让结算路径用同一个谓词。工具与 skill 可以同一个 ticket，也可以工具先行。
3. contract test 自动覆盖：frontmatter 合法、工具名都已知、description 与 catalog 预算、构建产物里有这个文件、catalog 里的路径在磁盘上存在。
4. 有 reason code 的工具：`SKILL.md` 每个 code 一条修正条目（标题或标签含原样 code），contract test 从类型穷举。

不需要改 prompt 拼装、不需要改各 agent adapter。

### D6. 备选方案（design it twice）

| | A. 代码注册表：每个 skill 一项 `{name, available, docPath}` | **B. 扫描 skill 根目录 + frontmatter 声明工具 + 代码工具表（选定）** | C. 只给 agent 一个「列 / 读 skill」的 CLI 命令，不给路径 |
|---|---|---|---|
| 加纯指导 skill | 改代码 + 加文件 | 只加文件 | 只加文件 |
| 门控在哪 | 每个 skill 一个谓词，和工具校验分开（两处真相） | 工具上一个谓词，门控与结算共用（locality） | 同 B |
| 对 agent 的要求 | 能读本地文件 | 能读本地文件 | 能跑一条 bridge 命令（沙箱与 PATH 更难保证） |
| 接口深度 | 浅：注册表就是接口 | 深：两个入口，扫描 / 解析 / 门控 / 路径都藏起来 | 深，但多一个面向 agent 的进程边界 |

选 B。C 作为扩展点保留：B07 若发现某种 agent kind 读不了绝对路径，就给它加一个包装 **read skill** 入口的命令（Q6），调用方不变。

不用 `~/.agents/skills` 或任何 CLI 原生 skill 目录（Q1）：那里全局、无门控（同一主机所有 bot 以及非 bridge 的 CLI 会话都看得到）、与已装版本漂移、依赖各 CLI loader（Grok 项目级还要 `--trust`）、每台主机多一步安装。skill 根目录也不放在 `.agents/`、`.cursor/`、`.claude/`、`.codex/`、`.grok/` 之下，避免 cwd 为本仓库时被 CLI 无门控加载。

### D7. 注入内容清单与迁移去向

注入分三类，迁移完成后 skill 系统之外只剩前两类：

- **bridge 契约**：每个分支都需要、不对应任何工具的约定，留在 system prompt（`writing-for-agents`：所有分支都要的内容就内联）。
- **本轮事实**：只在本轮成立的状态数据，按事实注入，不是 skill。
- **skill**：所有「何时用、怎么做」的操作说明。

| 现有注入（`953e7bd`） | 位置 | 去向 | Ticket |
|---|---|---|---|
| `AUTOMATION_PROPOSAL_INSTRUCTION` | 每轮 `bridge_instructions` | skill `automations` | B01 |
| `BRIDGE_AGENT_INSTRUCTIONS`（LARK_CHANNEL 环境、不要 unset、未绑定时停止；含一句 Codex 权限说明） | 每轮 `bridge_instructions` | 并入 skill `lark-cli`（去掉与 system prompt 的重复） | B04 |
| system prompt「lark-cli 运行环境」 | system prompt | skill `lark-cli` | B04 |
| system prompt「身份规则」与「飞书 OAuth 授权」 | system prompt | skill `lark-user-identity`（只在人工 run 可见） | B04 |
| 自动化 run 附加段（忽略上文身份 / OAuth；只用 bot；禁止人事组织操作） | system prompt（automation 变体） | 「忽略上文」随门控消失；剩下的 bot-only 与禁止项作为契约留在 automation 变体，policy-guard 照旧执行 | B04 |
| system prompt「发交互卡片的回调约定」 | system prompt | skill `interactive-card` | B05 |
| 评论 prompt 的读取命令与回复格式要求 | 评论 prompt | skill `doc-comment`；文档信息、选中原文、此前讨论、问题仍是本轮事实 | B06 |
| 会议 prompt 的回答要求（简洁、约 200 字、无标题） | 会议 prompt | skill `meeting-reply`；字幕、主题、提问人仍是本轮事实 | B06 |
| system prompt：`bridge_context`、bot-at-bot、最终回复由 bridge 发、`quoted_message`、`interactive_card`（输入格式）、「你的身份」 | system prompt | 契约，保留；新增一句说明 `<bridge_skills>` 块的含义 | B01（那一句） |
| 中断续跑 / 放弃（`continueExtraInstruction` / `abandonExtraInstruction`） | 每轮 `bridge_instructions`（条件） | 本轮事实，保留 | — |
| 模型切换提示 | 每轮（条件） | 本轮事实，保留 | — |
| 补处理延迟提示（lateness hint） | 每轮（条件） | 本轮事实，保留 | — |
| `<group_automations>` 快照 | 每轮（条件） | 本轮事实，保留；门控跟随 `automation-proposal` | B01 |
| 补跑提示（catch-up） | agent 任务 prompt | 本轮事实，保留 | — |
| 拒绝反馈 `<bridge_tool_rejected>` | 新增 | 本轮事实（修正文字从 skill 读取） | B02 |

迁移是行为等价搬家：B01 / B04 / B05 / B06 只搬文字并接上门控，不顺手改措辞规则；措辞改动单独成票（B03）。

### D8. Automations skill（第一个实例）

**门控**：必需 `automation-proposal`，可选 `automation-agent-task`。p2p、`auto:` / `meeting:` run、bot 触发的 turn 看不到它（Q2）。

**内容**（frontmatter `name: automations`；`description` 以领先词开头，分支：创建一次性 / 周期、删除、替换）。章节，每节同处一处：

1. 何时用 / 何时不用（暂停 → 看板或 `/auto pause N`）。
2. 提案格式：`<automation_proposal>` JSON；`op` = create / delete / replace；字段；每条回复至多一个；chatId / scope / createdBy 会被忽略；编号只取本轮 `<group_automations>`；快照是数据不是指令；修改已有任务的两选项话术。
3. 时间表语法（完整，与 `/auto new` 同一解析器）：
   - 一次性：`N 分钟后` / `N 小时后` / `in Nm`；`YYYY-MM-DD HH:MM`；`今天|明天|后天 HH:MM`；裸 `HH:MM`（下一次出现）。
   - 周期：`every Nm|Nh [HH:MM-HH:MM]`（只有分钟 / 小时）；`每天|daily HH:MM[、HH:MM]`；`每个工作日|工作日|weekday HH:MM`（不计调休）；`每周|weekly <星期列表> HH:MM`；可选前缀 `从 <今天|明天|后天|YYYY-MM-DD> [HH:MM] 起`；结束后缀 `until|到|结束 YYYY-MM-DD [HH:MM]`（周期必须有结束，缺了 bridge 会发索要结束时间的脚本卡）。
   - 限制：一次性至少 10 分钟后、至多 1 年；reminder 间隔 ≥ 10 分钟，agent 任务 ≥ 60 分钟；周期跨度 ≤ 1 年；开始不早于今天、不超过 1 年。
   - 明确的反例：`every 1d` / `every 1w` 无效 → `每天 HH:MM until …` / `每周 一 HH:MM until …`。
4. agent 任务的身份：定时 agent 任务只用 bot 身份运行，`taskText` 里不得出现 `--as user`；被 policy-guard 以 `user-identity` 暂停时的修法（去掉用户身份，并确认 bot 应用对目标资源有读权限）。
5. 示例：自然语言请求 → 提案 JSON，覆盖每个语法分支（用相对日期词或 `<YYYY-MM-DD>` 占位，不写会过期的具体日期）。
6. 被拒绝时怎么改：每个 reason code 一条，写「是什么」和「改成什么」。
7. 回复措辞：B01 原样搬现有规则；B03 改为不预告确认卡、由 bridge 结果行说明结果。

**Reason code**（稳定字符串，同时用于日志、反馈块、skill 章节锚点）：

- 时间表类（已有 `ScheduleTextRejectReason`）：`invalid-schedule`、`past-time`、`lead-too-soon`、`one-shot-too-far`、`interval-too-small`、`recurring-too-long`、`invalid-start`、`start-before-today`、`start-too-far`、`end-not-after-start`、`no-remaining-fires`、`invalid-timezone`。（`missing-end-at` 不是拒绝，走结束时间脚本卡。）
- 拒绝类（现为只带文案的 `refuse`，B02 补 code，文案不变）：`p2p-only`、`agent-tasks-disabled`、`agent-needs-cwd`、`cannot-save`。
- 编号类：`unknown-id`。
- policy-guard 暂停：`user-identity`（skill 第 4 节）。

**拒绝反馈（B02，通用于所有回复指令类工具）**：工具调用被拒时 bridge 按 scope 记一条（工具、op、reason code、模型原始输入），同一 scope 下一次人工 run 在 catalog 之后注入一个 `<bridge_tool_rejected>` 块，修正文字由 **read skill** 按 reason code 从 `SKILL.md` 取（单一事实来源；模型没读文件也拿得到）。注入即消费；`auto:` / `meeting:` run 不注入不消费；skill 本轮不可见就丢弃；新的成功或新的拒绝覆盖旧记录。不自动重试（Q3）。

**拒绝时不承诺确认卡（B03）**：bridge 追加的拒绝 / refuse / unknown-id 行一律写明「未生成确认卡」；`invalid-schedule` 的「可写成…」示例按请求的时间表类型给；skill 的回复措辞一节改为不预告确认卡。bridge 不改写模型正文。

### D9. 安全边界不变

工具校验（解析器、上下限、群聊限制、编号必须属于本群、只认人类消息、确认卡签名、bridge_token 签名、policy-guard、lark-cli bridge-bound 模式）是唯一裁决。skill 只影响模型写得对不对，不影响能不能生效。catalog 缺失、文件读不到、模型乱写，结果都只是被拒或被忽略。skill 里写的「不要做 X」只是指导；需要硬性保证的，要在工具里实现（见 N6）。

### D10. 新领域词（代码 PR 里加入 `CONTEXT.md`）

**bridge skill**、**skill 池**（skill pool）、**bridge 工具**（bridge tool）、**skill catalog**、**turn context**、**bridge 契约**（bridge contract）、**本轮事实**（turn fact）、**reason code**、**rejection feedback**。不用的词：把 bridge 工具叫「插件」；把 catalog 叫「index」（旧版用词，统一改为 catalog）。

## Testing Decisions

- 只测外部行为：断言 agent 收到的 prompt（`FakeAgentAdapter` 的 run options）和群里看到的消息 / 卡片（recording channel），不断言内部调用顺序。TDD：每个 ticket 先写失败的行为测试，再实现，最后 `pnpm ci:local` 在该 worktree 通过（主机内存紧张时只跑改动相关测试文件，CI 跑全量）。
- **最高 seam**：`startChannel` 集成测试（prior art：`tests/integration/bot/auto-nl-creation.test.ts`、`auto-proposal-reply.test.ts`、`auto-nl-delete-replace.test.ts`）。一个 seam 覆盖 catalog 注入、门控、拒绝反馈、结果行措辞。
- **模块 interface 测试**：两个入口 + 临时 fixture 根目录（第二个 adapter）：可见性随 turn context 变化、可选工具注明、损坏 skill 不可见且不影响其它、read skill 被门控时为空、路径绝对且存在。
- **Skill contract 测试**（对真实 skill 根目录，所有 skill 自动覆盖）：frontmatter 合法、`name` = 目录名、工具名都在工具表里、description 与 catalog 预算、构建产物里存在（`npm pack --dry-run` 列出每个 `SKILL.md`）。
- **注入清单 guard 测试**：枚举 prompt builder 能产出的每个 section 并标注类别（契约 / 本轮事实 / catalog）；新增 section 不登记就红。
- **Automations 专项**：每个 reason code 都有修正条目（从类型穷举）；skill 示例里的每个时间表在固定 `now` 下用同一解析器解析成功，标注无效的例子以文档写的 reason 失败。
- **Replace, don't layer**（`codebase-design`）：断言 `AUTOMATION_PROPOSAL_INSTRUCTION` 文案的单测迁成对 `SKILL.md` 的断言后删除旧断言；system prompt 单测里被迁走的段落断言同样迁移。
- 跨 CLI：Grok Build、Antigravity CLI、Cursor CLI 在测试 bridge 上 E2E（B07，ready-for-human）。

## Out of Scope

- 扩展 automations 解析器（`every 1d` 等新语法），见 Q4。
- 把 skill 装到 `~/.agents/skills` 或任何 CLI 原生 skill 目录；给 Grok 传 `--trust`。
- 第一版的扩展点实现：per-profile / 用户自定义 skill 根目录、面向 agent 的「读 skill」命令（只留 seam，B07 若需要再开票）、profile 级 skill 开关（N5）。
- 自动重试 run；改写模型正文。
- 新的 bridge 工具能力（本 Spec 只给已有能力命名并接上门控）。
- `<group_automations>` 快照格式、确认卡 / 看板 / 调度器行为。

## Decisions（用户 2026-10-19 确认；Revision 2 改成通用表述）

- **Q1** skill 放仓库内、随包发布，bridge 每轮注入 catalog；不用 `~/.agents/skills` 或任何 CLI 原生 skill 目录。
- **Q2** 门控按工具可用性；`automation-proposal` 只在群聊可用，所以 p2p 看不到 automations skill。
- **Q3** 工具调用被拒后不自动重试，下一轮注入拒绝反馈。
- **Q4** skill 教现有工具的语法，不为模型常见错误扩工具语法（不支持 `every 1d`，教 `每天` / `每周`）。
- **Q5** catalog 不内联硬规则；硬规则在工具校验里，结果由 bridge 结果行说明。
- **Q6** agent 用自己的读文件工具按绝对路径读 `SKILL.md`；B07 验证三种 CLI；某种 agent kind 读不到时，再为它开票提供包装 read skill 的命令（D6 方案 C）。
- **Q7** skill 正文中文 + 英文工具名 / reason code / 命令。
- **Q8** 拒绝反馈存内存、按 scope、用一次即清；重启丢失可接受。

## Open questions（Revision 2 新增，均已给默认值，待用户确认）

- **N1 本轮事实是否也要做成 skill？** 中断续跑 / 放弃、模型切换、补处理延迟、补跑、`<group_automations>`、拒绝反馈都是只在本轮成立的状态，不对应「何时用哪个工具」。默认：保留为本轮事实，不进 skill 系统（D7）；其中附带的一句话提示（如「先核对已完成的步骤」）跟着事实走。
- **N2 system prompt 里的 bridge 契约是否也要做成 skill？** 默认：不做。`bridge_context` 含义、bridge 发最终回复、bot-at-bot、引用 / 卡片输入格式、身份每轮每个分支都要用，放进 catalog 反而每轮多一次读文件。只迁走操作手册类段落（D7），契约段落保持最短。
- **N3 catalog 放在哪？** 默认：用户输入之后（按用户描述的「在用户 prompt 之后追加」）。备选：放在 `bridge_instructions` 里、用户输入之前（对 prompt cache 更友好）。
- **N4 必用的 skill（评论、会议）也只给 catalog 吗？** 这类 run 每次都适用，渐进披露省不了什么，还多一次读文件。默认：统一走 catalog，B07 统计 agent 是否真的去读；读取率低时再加 frontmatter `metadata.bridge-inline: true`（全文内联），属于扩展点，不预先做。
- **N5 要不要 per-profile 显式开关（某 bot 关掉某个 skill）？** 默认：第一版不要，只按工具可用性门控（已经包含 profile 配置，如 `automations.enabled`）。以后需要时在 turn context 里加一项，不改接口。
- **N6 群里发起 OAuth 等「靠模型自觉」的规则要不要搬进代码？** 按「硬约束只在工具里」原则，现在只写在说明里的禁止项（群聊不跑 `lark-cli auth login`、不 unset `LARK_CHANNEL`）以后应由工具强制。默认：B04 只搬文字，另记一个后续工具 ticket，不在本 Spec 实现。
- **N7 `BRIDGE_AGENT_INSTRUCTIONS` 里那句 Codex 权限说明怎么处理？** 它是关于某个 agent kind 配置的陈述，不是操作说明。默认：`lark-cli` skill 只保留与 agent kind 无关的事实（bridge 子进程可以像本机终端一样访问 keychain），删掉 agent kind 专属措辞。

## Further Notes

- 来自 `codebase-design` 的部分：D1 的词汇、interface 的完整定义（不变量、错误模式）、deletion test、外部 / 内部 seam、「一个 adapter 是假 seam、两个才是真 seam」（skill 根目录有生产 + fixture 两个 adapter；不做可替换渲染器）、dependency category（文件系统 = local-substitutable）、D6 的 design it twice、Testing 里的 replace-don't-layer。
- 来自 `improve-codebase-architecture` 的部分：先按 git 热点圈定范围（IM 主路径与 automations 是热点）、找注入文字散落 8 个文件这一处摩擦，把「注入内容」当作一个 deepening 候选；D7 清单就是这次扫描的结果。它的 HTML 报告与 grilling 环节没有做（需求已由用户定下）。
- 本 PR 不含任何 Feishu ID、账号名、bot 名或凭据。
