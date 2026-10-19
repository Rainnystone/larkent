# Task 9d — P09d showToolCalls 原样展示内部 bridge tool 调用

**Status:** ready-for-agent · bug · P3
**Delivers:** `showToolCalls` 开启时，bridge tool（`lark-channel-bridge tool`）调用在工具进度卡中折叠为友好标签（如“自动化：list”“自动化：create”），不展示 shell 命令、客户端路径和协议 JSON。
**Found in:** [P09](P09-real-feishu-acceptance.md) 真实飞书 E2E，候选版本 `0b55865`（Cursor、Kimi、Grok）
**Worker class:** mechanical
**Blocked by:** None
**Spec:** 修订 [D5](../../bridge-skills.md#d5--共用调用入口与可信上下文)（见规格中的 P09d 修订行）

## Bug

- **场景：** profile 设置 `preferences.showToolCalls: true`，用户在群里发起任意自动化请求（创建、替换、列出）。
- **期望：** 内部 automation 工具调用隐藏，或显示为友好标签。
- **实际：** 工具进度卡原样展示 `node "$LARK_BRIDGE_TOOL_CLIENT" tool <<'EOF' {"version":1,"operation":"automation.list",...}`、bridge 可执行文件的绝对路径，展开后还有 stdout 协议 JSON（revision、operationId 等）。Antigravity 适配器不产生工具进度卡，因此不受影响。已核对卡片中只有环境变量名，运行凭据的值没有出现。
- **来源：** 不是测试消息要求的；由本 PR 设计引入——SKILL.md 要求经 shell 执行 `node "$LARK_BRIDGE_TOOL_CLIENT" tool`，每次 automation 调用都是普通 Shell/Bash 工具调用，而进度卡对所有工具调用一视同仁。旧版（`953e7bd`）automation 走回复标签不经 shell，因此这是新的可见面。
- **严重度：** P3（`showToolCalls` 默认关闭，无凭据泄露）。若生产 profile 默认开启，升为 P2。

## Evidence

- P09 证据目录 `read-cursor-1.json`、`read-cursor-3.json`、`read-kimi-1.json`、`read-C1.json`…`read-C4.json`（工具进度卡回读），及测试截图（盒子本地证据目录）。
- 4 个测试 profile 均显式设置 `showToolCalls: true`。

## Root cause（`0b55865`）

- `plugins/automation/skills/automations/SKILL.md:6`、`src/bridge-tools/prompt.ts:7`：调用方式是 shell 执行共用客户端。
- `src/card/run-state.ts:117`：`tool_use` 事件不区分来源，统一进入 `blocks`。
- `src/bot/channel.ts:2050` `filterForPrefs`：只按 `getShowToolCalls`（`src/config/schema.ts:259`）整体保留或移除工具块；没有识别 bridge tool。
- `src/card/tool-render.ts:15,21` `toolHeaderText` / `toolBodyMd`：直接渲染原始命令与输出。
- 默认值：`src/cli/profile-bootstrap.ts:41` 写入 `showToolCalls: false`。

## What to build

- 在 run-state/渲染层识别 bridge tool 调用：以 runtime 的 shell 工具输入中引用 `LARK_BRIDGE_TOOL_CLIENT` 客户端并带 `tool` 子命令为准（各 runtime 的 shell 工具名不同，识别放在共用 reducer，不按 CLI 分叉）。
- 识别后的工具块只渲染标签：`自动化：<operation 动词>` / `插件：<plugins.* 动词>`，状态图标沿用 done/error；正文不展示命令、路径、stdin JSON 和 stdout。解析不出 operation 时用通用标签“bridge 工具”。
- 错误状态仍可见（红色边框 + 标签），细节保留在文件日志。
- `showToolCalls: false` 行为不变（全部隐藏）；非 bridge 工具调用渲染不变。

## Acceptance criteria

- [ ] 单测（tool-render / run-renderer）：Bash、Shell 等不同工具名包装的 bridge tool 调用渲染为 `自动化：list`、`自动化：create` 等标签；卡片 JSON 中不出现 `LARK_BRIDGE_TOOL_CLIENT`、客户端路径、`"operation"`、`operationId`。
- [ ] 单测：普通 shell 命令仍按原样渲染；折叠阈值（`COLLAPSE_TOOL_THRESHOLD`）下的汇总标题也使用友好标签。
- [ ] 单测：bridge tool 返回错误时卡片显示错误状态的标签。
- [ ] `pnpm ci:local` 通过。
- [ ] P09 重跑：`showToolCalls: true` 的 Cursor 或 Kimi profile 创建一个提醒，进度卡只出现友好标签。

## Non-goals

- 改变 bridge tool 的 shell 调用方式或为各 CLI 注册原生工具（D5 保持不变）。
