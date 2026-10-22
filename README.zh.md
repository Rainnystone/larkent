# Larkent: Agent for lark

把你的 coding agent 接入飞书 / Lark。通过私聊或群聊，使用运行在自己电脑或服务器上的 Claude Code、Codex CLI、Kimi Code、Grok Build、Cursor CLI、Antigravity CLI 和 Devin CLI。

Larkent 受到 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 启发，并在此基础上进行了架构重构：统一 agent 注册与进程执行机制，让多个 CLI 共用运行底座，同时保持各 bot 的配置、会话和运行状态独立。

[English](README.md) | **简体中文**

## 可以做什么

- **在聊天里处理任务。** 私聊 bot，或在群里 `@bot`，让 agent 回答问题、查看项目、执行编码任务。
- **延续工作上下文。** 连续对话、切换工作目录、停止当前任务，之后再恢复会话。
- **同时运行多个 agent。** 每个 bot 可以选择自己的 CLI，保存独立配置和会话；一台主机可运行多个 profile。
- **读取飞书中的上下文。** 使用 owner 授权的用户身份读取 wiki、文档和聊天记录，回复仍以 bot 身份发出。
- **定时执行工作。** 创建经人工确认、按排期运行的提醒和 agent 任务。
- **选择运行方式。** 支持终端前台、后台服务，以及管理多个 profile 的本地 Web 控制台。

## 支持的 CLI

| Agent | Profile kind | CLI 程序 |
| --- | --- | --- |
| Claude Code | `claude` | `claude` |
| Codex CLI | `codex` | `codex` |
| Kimi Code | `kimi` | `kimi` |
| Grok Build | `grok` | `grok` |
| Cursor CLI | `cursor` | `cursor-agent` 或 Cursor 的 `agent` |
| Antigravity CLI | `antigravity` | `agy` |
| Devin CLI | `devin` | `devin` |

七种 CLI 遵循相同的运行契约。各自的参数、图片处理和原生历史能力由对应适配器负责；创建 profile 时明确选择 agent。

## 环境要求

- Node.js 20.12 或更新版本；pnpm 版本以 [package.json](package.json) 为准。
- 至少安装并登录一种支持的 coding CLI。
- 已安装 [Lark CLI](https://github.com/larksuite/cli)。
- 可以注册应用或授权已有应用的飞书 / Lark 账号。
- 主机能够访问飞书 / Lark，以及所选 CLI 对应的服务。

沿用 coding CLI 原有的登录环境。Larkent 的配置和会话数据单独存放。

## 快速开始

从源码安装：

```sh
git clone https://github.com/Rainnystone/larkent.git
cd larkent
pnpm install --frozen-lockfile
pnpm build
```

创建一个 profile。下面以 Codex 为例，将 `codex` 换成你要接入的 CLI kind：

```sh
node bin/lark-channel-bridge.mjs profile create my-agent --agent codex
node bin/lark-channel-bridge.mjs run --profile my-agent
```

在支持 TTY 的终端中按提示完成应用注册。使用已有应用时添加 `--app-id`，再按提示输入 secret；国际版 Lark 添加 `--tenant lark`。

**首次 setup 必须完成 owner 用户身份授权。** 除应用注册外，负责 setup 的 agent 还要主动请 owner 在当前 profile 的环境中完成一次 `--domain all` 完整用户身份 OAuth，然后验证实际 wiki/文档读取，以及 owner 有权访问的另一个群的记录读取。有效授权在重启后复用。

完整的注册、授权和验证步骤见 [agent setup 指南](docs/agent-setup.md)。负责部署本仓库的 agent 应先读 [AGENTS.md](AGENTS.md)。

完成后，私聊 bot 或在群里 `@bot` 即可开始使用。前台进程用 `Ctrl-C` 停止。

## Bridge 插件与 skill

每个 coding CLI 只知道自身配置提供的工具。Larkent 有一些自己的能力（例如定时任务），但 CLI 自己找不到、也不会调用它们。Bridge 插件为所有支持的 CLI 统一解决这个问题：插件是一组 skill（普通的 `SKILL.md` 说明，可附带参考资料和脚本），由 bridge 交给当前运行的 agent。

**工作方式**

1. 不需要为每个 CLI 单独安装。每次聊天运行（含续接会话和定时 agent 运行），bridge 都会告诉 agent 有哪些插件可用，以及如何调用 bridge 的工具客户端。
2. agent 需要某个 skill 时，再通过该客户端按需读取完整说明。
3. 内置的 [`plugins/automation`](plugins/automation/) 随 Larkent 提供、始终可用，所以每个 CLI 开箱即会使用自动任务。

**添加自己的插件（可选）**

1. 在主机上把每个插件准备成一个目录，包含 `.codex-plugin/plugin.json` manifest 和 skill 文件夹。
2. 在数据目录（默认 `$HOME/.lark-channel`）创建 `plugins.json`，列出每个插件的绝对路径：

   ```json
   { "schemaVersion": 1, "packages": ["/srv/larkent-plugins/my-plugin-v1"] }
   ```

3. 重启 profile。使用同一数据目录的 profile 共用这份列表。

Bridge 插件与 CLI 自己的原生插件分开。bridge 不下载或安装任何东西，不托管 MCP 服务或 hooks，不改变 CLI 的信任设置，也不替 agent 执行插件脚本。Manifest 格式、依赖声明、诊断和版本更新见 [External bridge plugins](docs/operations.md#external-bridge-plugins)。

## 自动任务

自动任务让 bot 在群里按时间表做事：

- **提醒**：到期时发送一条消息。
- **agent 任务**：到期时运行 agent，工作目录为创建任务时设定的目录，使用该 profile 已有的授权。

**开启**

在 `config.json` 中把该 profile 的 `automations.enabled` 设为 `true`（见 [配置与身份](docs/operations.md#configuration-and-identity)）。需要 agent 任务时再打开 `automations.agentTasks`。`automations.timezone` 默认使用主机本地时区（无法识别时为 UTC）；如需其他时区，设为 IANA 名称，例如 `Europe/London`、`America/New_York`。修改后重启 profile。自动任务仅支持群聊。

**直接说出来就能创建**

1. 在群里 `@bot`，用自然语言描述，例如：
   - 「@bot 今天、明天、后天每天 09:00 提醒我检查构建」
   - 「@bot 每个工作日 18:00 总结这个仓库当天的提交」（agent 任务；先用 `/cd` 设好工作目录）
2. agent 预览排期后发出**确认卡**，显示任务类型、名称、时间表、时区、接下来几次触发时间、结束时间、任务内容和执行身份。
3. 点 **是** 保存，点 **否** 取消。必须由人确认才会保存，agent 不能代为确认。
4. 周期任务必须有结束时间。如果没说，bot 会先发一张补全卡，可快速选择一周、两周、一个月、三个月、年底或一年，然后再发确认卡。

最早从 10 分钟后开始；一次性任务最远一年内。

**查看与管理**

- 直接问 agent：「@bot 这个群有哪些定时任务？」「暂停每天的构建提醒」「删除 3 号任务」。
- 暂停和恢复立即生效；删除和替换会先发确认卡。
- 也可以用聊天命令：`/auto list`、`/auto pause <编号>`、`/auto resume <编号>`、`/auto delete <编号>`，以及 `/auto new <时间表> | <名称> | <内容>`（agent 任务用 `/auto new agent ...`）。

任务按 profile 保存在数据目录中，重启后保留。定时运行的 agent 可以使用插件，但不能自己创建或修改排期。操作回执、恢复方式和需要订阅的飞书事件见 [运行指南](docs/operations.md#automations-events)。

## 运行与配置

后台服务、Web 控制台、聊天命令、配置、日志和排错方法统一见 [运行指南](docs/operations.md)。休眠、重启或 WebSocket 闪断后的自愈见 [Self-heal](docs/operations.md#self-heal)。

CLI 入口沿用 `bin/lark-channel-bridge.mjs`。默认数据目录为 `$HOME/.lark-channel`，可以通过 `LARK_CHANNEL_HOME` 指定其它位置。每个 profile 单独保存凭据与会话；多个 agent 共用工作目录时，运行状态隔离不等于目录内文件隔离。

## 开发

```sh
pnpm ci:local
```

该命令执行 diff 检查、测试、类型检查和构建。真实 CLI smoke 需要安装相应 CLI 并显式开启环境开关，见 [运行指南](docs/operations.md#development-checks)。

- [Agent setup](docs/agent-setup.md)
- [运行术语](CONTEXT.md)
- [Agent 适配器](src/agent/)
- [运行时实现](src/runtime/)

## 致谢与许可证

感谢 [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 提供最初的灵感与基础。

Larkent 使用 [MIT License](LICENSE)，保留原有版权声明。
