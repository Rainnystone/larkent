# Spec: Bridge skills（bridge 原生工具的共享 skill 层）

Status: ready-for-agent · Docs track: PR（branch `docs/bridge-skills`，本 PR，never merged）· Code track: branch `feat/bridge-skills`（from `origin/master`；one shared code PR，code only）
Tickets: [`bridge-skills/tickets/`](bridge-skills/tickets/README.md)
Baseline: `master@953e7bd`（2026-10-19 08:14 UTC+8，PR #49 automations 已合入）。本文只写行为、决策、边界与验收；代码锚点（file:line，已对 `953e7bd` 核对）写在各 ticket。
Method: [mattpocock/skills](https://github.com/mattpocock/skills) `to-spec` → `to-tickets`；skill 文档写法遵循同一仓库的 `writing-for-agents`（含 `SKILL-MECHANICS.md`）。Problem 已诊断，无 grill。

---

## Problem Statement

bridge 自己实现的工具（目前只有 **automation**：`<automation_proposal>` 提案 → bridge 校验 → 确认卡）是靠 `proposal.ts` 里一段硬编码的 `AUTOMATION_PROPOSAL_INSTRUCTION` 教给模型的。profile 开启 `automations.enabled` 时，这段话每轮都追加到 `extraInstructions`（约 1.5k 字，每轮都付 context load）。

2026-10-19 线上证据（一个真实群，Grok Build profile）：

- 模型连续三次写出 `every 1d ...` 作为时间表，三次都被 bridge 以 `invalid-schedule` 拒绝。语法里 `every` 只接受分钟 / 小时（`every Nm` / `every Nh`），每天固定时刻要写 `每天 HH:MM until <日期>`。说明里只有 `every 30m` / `every 10m` 的例子，没有 `每天` / `每周` / `每个工作日` 的完整写法，也没有任何「被拒绝后怎么改」的映射。
- 被拒绝时，群里能看到 bridge 追加的一行 `⚠️ 没有创建任务：无法解析时间表「…」。可写成「明天 09:00」…`，但这一行的提示只覆盖一次性时间，对「每天」类需求反而是误导；模型下一轮的上下文里也拿不到机器可用的拒绝原因（resume 的会话转录只有模型自己的输出，没有 bridge 追加的那一行；只有人类引用那条消息时才可能看到）。所以同样的错写了三次。
- 模型正文承诺了「我给你发确认卡」，而同一条回复末尾 bridge 写的是「没有创建任务」。现有说明要求模型「只说点确认卡上的「是」后生效」，这本身就在诱导模型提确认卡；可模型写正文时并不知道提案会不会通过。

更一般地：以后还会有别的 bridge 原生工具（每个 profile 开关不同）。每加一个就往 prompt 里塞一段硬编码长句，不可扩展、无法测试其教学效果，也没有渐进披露。

## Solution

在 bridge 里建一层 **bridge skill**：每个 bridge 原生工具一份自然语言用法文档，skill 形态（frontmatter `name` / `description`，何时用、语法、示例、每种拒绝原因如何修正），随仓库与 npm 包一起发布，与解析器同版本。

- 每轮只注入一个很短的 **skill index**：每个**当前可用**的 bridge skill 一行（description + 文档绝对路径）。模型需要时再用自己的读文件工具读全文（渐进披露）。
- **capability-gated**：只有该 bot、该轮真正可用的工具才进 index（`automations.enabled`、非 `auto:` / `meeting:` scope、群聊）。没开功能的 bot 看不到、也不会提。
- 工具本身仍是代码里确定性、原子的能力（提案标签 + bridge 校验 + 确认卡）；skill 只教组合与写法。安全与正确性永远由 bridge 校验裁决，不依赖模型是否读了文档。
- 提案被拒绝时，bridge 把**机器可用的拒绝原因**（稳定的 reason code + 原始输入 + 该原因在 skill 文档里的修正条目）在同一 scope 的下一轮注入给模型，模型据此改写重试。
- 拒绝时 bridge 自己那一行明确写「未生成确认卡」；skill 文档教模型在正文里不预告确认卡、由 bridge 那一行说明结果。

第一个用户是 automations。必须在 Grok Build、Antigravity CLI、Cursor CLI 三种 agent kind 上都可用（index 走 prompt，与各 CLI 的 skill loader 无关，所以 Claude / Codex / Kimi 也自动可用）。

## User Stories

1. As a group member, I want to say “每天 9 点提醒我写日报，到年底”, so that the bot proposes `每天 09:00 until <年底>` and I get a confirm card on the first try.
2. As a group member, I want weekly and workday schedules (“每周一三五 10:00”, “工作日 9:00”) to be written correctly by the bot, so that I don't have to learn the grammar.
3. As a group member, I want “每 2 小时” to become `every 2h`, and “每天” never to become `every 1d`, so that interval and daily schedules are not confused.
4. As a group member, when a proposal is rejected, I want the bot's next try to fix the specific problem the bridge named, so that I don't watch the same mistake three times.
5. As a group member, I want the bot's text to never promise a confirm card that then does not appear, so that I can trust what the bot says.
6. As a group member, when a proposal is rejected, I want the bridge line to state plainly that no confirm card was generated, so that the outcome is unambiguous even if the model's text was wrong.
7. As a group member, I want rejection lines whose suggestions match the kind of schedule I asked for, so that a daily request is not answered with only one-shot examples.
8. As a bot owner, I want bots without automations enabled to never see or propose automations, so that disabled features stay invisible.
9. As a bot owner, I want unattended `auto:` / `meeting:` runs to never see the automations skill, so that automated runs cannot create more automations.
10. As a bot owner, I want agent-task proposals to be taught as unavailable when `automations.agentTasks` is off, so that the bot proposes reminders instead of getting refused.
11. As a bot owner running Grok Build, I want the skill to work without passing `--trust`, so that the bridge does not widen Grok's project trust.
12. As a bot owner running Antigravity CLI, I want the skill to work without any per-host skill install, so that a fresh host works after `start`.
13. As a bot owner running Cursor CLI, I want the same behaviour, so that all agent kinds stay equal.
14. As a bot owner, I want the skill docs to ship inside the package and match the installed parser version, so that docs and grammar cannot drift.
15. As a bot owner, I want the per-turn prompt overhead for bridge tools to shrink to a short index, so that every turn costs fewer tokens.
16. As a maintainer, I want to add the next bridge tool by adding one skill doc and one registry entry with a capability predicate, so that the layer is extensible without editing prompt strings.
17. As a maintainer, I want a test that fails when the parser can produce a reject reason the skill doc has no recovery entry for, so that the doc stays complete.
18. As a maintainer, I want a test that every schedule example in the skill doc parses (and every documented invalid example fails with the documented reason), so that the doc stays truthful.
19. As a maintainer, I want rejection reason codes to be stable strings shared by logs, feedback and doc, so that one vocabulary serves humans, models and tests.
20. As a maintainer, I want the bridge's validation to stay authoritative regardless of what the model read, so that a model that skipped the doc can still never create an invalid task.
21. As a model running in a group, I want a compact index telling me which bridge tools exist this turn and where their full docs are, so that I read the doc only when the user asks for that tool.
22. As a model, I want a structured rejection notice at the start of my next turn (reason code, my rejected input, the fix), so that I can correct my proposal deterministically.
23. As a model, I want the doc's recovery section keyed by the same reason code the bridge sends, so that I can jump straight to the fix.
24. As a group member, I want rejection feedback to be consumed once, so that an old rejection does not haunt later unrelated turns.
25. As a group member, I want group task snapshots (`<group_automations>`) to keep working unchanged, so that delete / replace by id is unaffected.

## Implementation Decisions

### D1. 文档放在哪里：仓库内随包发布 + bridge 注入 index（选定），不用 `~/.agents/skills`

Dungeon Master 的 loader 调研：三种 CLI 唯一共同读取的位置是 `~/.agents/skills`；Grok 的项目级 skills / `AGENTS.md` 需要 `--trust`，bridge 的 Grok argv 不传；Antigravity 读 `~/.gemini/config/skills`（可软链）与 `.agents`；Cursor CLI 读 `.cursor` / `.claude` / `.codex` / `.grok` / `.agents`。

| | 仓库内文档 + bridge 注入 index（选定） | `~/.agents/skills` |
|---|---|---|
| capability gating | 每 profile、每轮按开关注入 | 全局、无门控：同一主机所有 bot、以及非 bridge 的 CLI 会话都看得到 |
| 版本一致 | 文档与解析器同 commit、同包 | 主机上单独安装，会与已装版本漂移 |
| 对 CLI 的依赖 | 只要求 agent 能读本地文件 | 依赖各 CLI loader 行为与路径，Grok 项目级还要 `--trust` |
| 部署 | 无额外步骤 | 每台主机需要安装 / 软链步骤 |
| 可测试 | prompt 与文档可单测 / 集成测 | 只能 E2E |
| 原生渐进披露 | 自己实现（index = description，按需读文件） | CLI 原生 |

结论：选仓库内文档。`~/.agents/skills` 唯一的优势（原生渐进披露）我们用一行 index 就能复刻，它的全局无门控则直接违反 capability gating。奥卡姆剃刀：不引入主机安装步骤，不碰 `--trust`。

- 文档目录在仓库根的独立目录（不在 `.agents/`、`.cursor/` 等任何 CLI 会自动加载的位置，避免在 cwd 为本仓库时被无门控加载），每个工具一个子目录，入口文件为 `SKILL.md`。该目录加入 `package.json` 的 `files`，npm 包里也有。
- bridge 运行时从自身安装位置解析出文档的**绝对路径**（源码运行与 `dist` 构建运行都要正确），注入 index。

### D2. Bridge skill registry（扩展接口）

一个很小的深模块，对外只有一个函数：给定本轮上下文（profile 配置、scope、chat 类型）返回 index 文本或空。内部是一个注册表，每项：

- `name`：与 `SKILL.md` frontmatter `name` 一致；
- `available(ctx)`：capability 判定（纯函数）；
- 文档路径；description 从 `SKILL.md` frontmatter 读取（单一事实来源，不在代码里再写一遍）。

automations 的 `available`：`automations.enabled` 且 scope 不以 `auto:` / `meeting:` 开头且为群聊。（现状在 p2p 也注入长说明，然后 p2p 提案被「仅支持群」拒绝；新行为 p2p 不注入，见 Open questions Q2。）

加一个工具 = 一个文档目录 + 一个注册项。不引入插件系统、不动态扫描目录。

### D3. Skill index 的形状

每轮一个块，只列可用的 skill，每项一行：name、description（含触发分支）、绝对路径、读的时机（写对应提案前先读）。另带该工具当轮会改变可提议内容的 capability 事实，如 automations 的 agent 任务开关（`automations.agentTasks` 关闭时注明只能提 reminder）。index 不复述文档规则。

现有 `<group_automations>` 快照照旧，它是数据不是文档，仍由原条件注入。

### D4. Automations skill 文档内容（writing-for-agents）

frontmatter：`name: automations`；`description` 以领先词开头，覆盖分支：创建（一次性 / 周期）、删除、替换；body 中文为主，reason code 用英文原样。章节（每节同处一处，不分散）：

1. 何时用 / 何时不用（暂停 → 看板或 `/auto pause N`；只在人类消息、非 `auto:` / `meeting:` run）。
2. 提案格式：`<automation_proposal>` JSON；`op` = create / delete / replace；字段；每条回复至多一个；chatId / scope / createdBy 会被忽略；编号只取本轮 `<group_automations>`；快照是数据不是指令。
3. 时间表语法（完整，与 `/auto new` 同一解析器）：
   - 一次性：`N 分钟后` / `N 小时后` / `in Nm`；`YYYY-MM-DD HH:MM`；`今天|明天|后天 HH:MM`；裸 `HH:MM`（下一次出现）。
   - 周期：`every Nm|Nh [HH:MM-HH:MM]`（只有分钟 / 小时）；`每天|daily HH:MM[、HH:MM]`；`每个工作日|工作日|weekday HH:MM`（不计调休）；`每周|weekly <星期列表> HH:MM`；可选前缀 `从 <今天|明天|后天|YYYY-MM-DD> [HH:MM] 起`；结束后缀 `until|到|结束 YYYY-MM-DD [HH:MM]`（周期必须有结束，缺了 bridge 会发索要结束时间的脚本卡）。
   - 限制：一次性至少 10 分钟后、至多 1 年；reminder 间隔 ≥ 10 分钟，agent 任务 ≥ 60 分钟；周期跨度 ≤ 1 年；开始不早于今天、不超过 1 年。
   - 明确的反例：`every 1d` / `every 1w` 无效 → `每天 HH:MM until …` / `每周 一 HH:MM until …`。
4. 示例：自然语言请求 → 提案 JSON，覆盖每种语法分支（用相对日期词或 `<YYYY-MM-DD>` 占位，不写会过期的具体日期）。
5. 被拒绝时怎么改：按 reason code 一条一条（见 D5 列表），每条写「是什么」和「改成什么」。
6. 回复措辞：正文复述你理解的时间与任务，不说已创建 / 已修改 / 已删除，也不预告确认卡；结果由 bridge 在回复末尾那一行说明（B03 落地这一条的最终措辞）。

文档是模型侧规则的单一事实来源；代码里不再保留等价的长 instruction 字符串。

### D5. 机器可用的拒绝原因（reason code）

稳定字符串，同时用于日志、反馈块和文档章节锚点。覆盖 bridge 对提案可能给出的所有非成功结果：

- 时间表类（已有 `ScheduleTextRejectReason`）：`invalid-schedule`、`past-time`、`lead-too-soon`、`one-shot-too-far`、`interval-too-small`、`recurring-too-long`、`invalid-start`、`start-before-today`、`start-too-far`、`end-not-after-start`、`no-remaining-fires`、`invalid-timezone`。（`missing-end-at` 不是拒绝，走结束时间脚本卡。）
- 拒绝类（现为只带文案的 `refuse`，需补 code）：`p2p-only`、`agent-tasks-disabled`、`agent-needs-cwd`、`cannot-save`；
- 编号类：`unknown-id`。

`refuse` verdict 增加 code 字段，文案不变。

### D6. 拒绝反馈给模型（next-turn feedback）

- 提案被拒绝（D5 任一）时，bridge 记一条 **rejection feedback**，按 scope 存（内存即可，进程重启丢失可接受，见 Q8）：tool、op、reason code、模型原始时间表 / 编号。
- 同一 scope 的下一次人类触发的 run，bridge 在 index 之后注入一个结构化块：上述字段 + 文档里该 reason code 的修正条目原文（从 `SKILL.md` 按 code 取，单一事实来源；即使模型没去读文件，也拿到了修正方法）。注入后即消费，只用一次。`auto:` / `meeting:` run 不注入、不消费。
- 不自动发起重试 run（见 Q3）；模型在用户下一条消息时据此改写。
- 新的成功提案或新的拒绝覆盖旧的记录。

### D7. 拒绝时不承诺确认卡

- bridge 追加的拒绝 / refuse / unknown-id 行一律明确包含「未生成确认卡」（或等价短语，B03 定稿），无论模型正文写了什么。bridge 不改写模型正文（`appendReplyLine` 契约保持）。
- invalid-schedule 的「可写成…」示例按提案的时间表类型给（周期请求给周期写法，一次性给一次性写法），不再一律给一次性例子。
- skill 文档的「回复措辞」一节改为：不预告确认卡、不说生效条件以外的状态；替换 / 删除的两选项话术保留。

### D8. 安全边界不变

bridge 校验（解析器、下限 / 上限、群聊限制、编号必须属于本群、只认人类消息、确认卡签名）保持唯一裁决。skill 文档只影响模型写得对不对，不影响能不能生效。index 缺失、文档读不到、模型乱写，结果都只是被拒或被忽略。

## Testing Decisions

- 测外部行为，不测实现细节：断言 agent 收到的 prompt（`FakeAgentAdapter` 的 run options）和群里看到的消息 / 卡片（recording channel），不断言内部函数调用顺序。TDD：每个 ticket 先写失败的行为测试，再实现，最后 `pnpm ci:local` 在该 worktree 通过（主机内存紧张时只跑相关测试文件，CI 跑全量）。
- 最高 seam：`startChannel` 集成测试（prior art：`tests/integration/bot/auto-nl-creation.test.ts`、`auto-proposal-reply.test.ts`、`auto-nl-delete-replace.test.ts`）。一个 seam 覆盖 index 注入、gating、拒绝反馈、拒绝行措辞。
- 文档契约测试（unit）：
  - 每个 D5 reason code 在 `SKILL.md` 都有修正条目（从类型穷举出发，新增 reason 不补文档就红）。
  - 文档「示例」里的每个时间表在固定 `now` 下用 `/auto new` 同一解析器解析成功；文档标注无效的例子（`every 1d` 等）以文档写的 reason 失败。
  - frontmatter 有 `name` 与 `description`，`name` 与注册项一致。
- 打包：解析出的文档绝对路径存在；`package.json` `files` 包含文档目录（`npm pack --dry-run` 列表含 `SKILL.md`）。
- 现有 `proposal.test.ts` 中断言 `AUTOMATION_PROPOSAL_INSTRUCTION` 文案的用例迁移为对 `SKILL.md` 内容的断言（同样的语法要点必须在文档里）。
- 跨 CLI：Grok Build、Antigravity CLI、Cursor CLI 在测试 bridge 上 E2E（B04，ready-for-human）。

## Out of Scope

- 扩展解析器（`every 1d` 等新语法）：默认不做，见 Q4。
- 把 bridge skills 安装到 `~/.agents/skills` 或任何 CLI 原生 skill 目录；给 Grok 传 `--trust`。
- 自动重试 run、模型侧的安全约束。
- automations 之外的新 bridge 工具（只交付扩展接口）。
- 改写模型正文（例如删掉正文里提确认卡的句子）。
- `<group_automations>` 快照格式、确认卡 / 看板 / 调度器行为。

## Open questions（给用户）

- **Q1. 文档位置**：按 D1 选仓库内随包发布 + bridge 注入 index，不用 `~/.agents/skills`。是否同意？
- **Q2. p2p 是否注入**：默认只在群聊注入（p2p 本来就会被「仅支持群」拒绝）。代价：私聊里问「能不能定时提醒」时模型不知道有这个功能。要不要在 p2p 也注入一行「仅群内可用」？
- **Q3. 拒绝后是否自动重试**：默认不自动重试，下一轮注入反馈。备选：拒绝后 bridge 立刻追加一次（至多一次）修正 run，再出卡；代价是多一次 agent run 与延迟。
- **Q4. `every 1d` 是否支持**：默认只教语法（文档写明 `every` 只有 m / h，日周用 `每天` / `每周`），不扩解析器。备选：解析器把 `every Nd` 归一成 `每天`（N=1）或拒绝 N>1。
- **Q5. index 里是否保留一条硬规则**（如「点「是」前不说已创建」）：默认不保留，由 D7 的 bridge 行兜底。
- **Q6. 读不到文件时**：若某 CLI 在受限 access mode 或 workspace 沙箱下无法读包内绝对路径，是否给该 agent kind 回退为内联全文？默认先由 B04 E2E 验证三种 CLI，确有问题再加回退。
- **Q7. 文档语言**：默认中文正文 + 英文 reason code。
- **Q8. 反馈持久化**：默认内存，按 scope，只用一次；重启丢失。是否需要持久化？

## Further Notes

- 现有 `AUTOMATION_PROPOSAL_INSTRUCTION` 的每条规则都要在 B01 迁移进 `SKILL.md`（行为等价），B03 才改措辞规则；避免一次改两件事。
- 新领域词（bridge skill、skill index、rejection feedback、reason code）在代码 PR 里加入 `CONTEXT.md`。
- 本 PR 不含任何 Feishu ID、账号名或凭据。
