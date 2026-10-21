# Larkent: Agent for lark

把你的 coding agent 接入飞书 / Lark。通过私聊或群聊，使用运行在自己电脑或服务器上的 Claude Code、Codex CLI、Kimi Code、Grok Build、Cursor CLI 和 Antigravity CLI。

Larkent 受到 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 启发，并在此基础上进行了架构重构：统一 agent 注册与进程执行机制，让多个 CLI 共用运行底座，同时保持各 bot 的配置、会话和运行状态独立。

[English](README.md)

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

六种 CLI 遵循相同的运行契约。各自的参数、图片处理和原生历史能力由对应适配器负责；创建 profile 时明确选择 agent。

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

Agent CLI 只认识自身工具和原生插件教给它的能力。bridge 通过共用的 JSON 客户端提供自己的工具（例如自动任务排期），但 CLI 没有内建方式发现这个客户端及其调用约定，单靠自己无法稳定调用。Bridge 插件以与具体 CLI 无关的方式补上这一环。

- 每次 IM 运行（含续接会话和定时 agent 运行）都会收到简短的插件摘要和通用工具约定；完整 skill 正文与资源通过 bridge 工具按需读取（`plugins.list` / `plugins.inspect` / `plugins.read`）。
- 内置的 [`plugins/automation`](plugins/automation/) 包提供 automations skill，所有支持的 CLI 由此获得同一套自动任务约定。
- 维护者可在 `<data-root>/plugins.json` 中列出包的绝对路径来添加更多插件，同一数据根下的 profile 共用。Bridge 插件与各 CLI 的原生插件分开：bridge 不安装、不下载、不托管 MCP/hooks，也不改变 CLI 信任设置；脚本只返回位置与内容，不代为执行。

Manifest 格式、依赖声明、诊断与更新步骤见 [External bridge plugins](docs/operations.md#external-bridge-plugins)。

## 自动任务

打开 `automations.enabled` 后，bot 可以在群里运行定时任务：**提醒**到期投递正文；**agent 任务**（需打开 `automations.agentTasks`）到期时在创建时绑定的工作目录运行 agent，使用该 profile 已有的授权。

- 用自然语言提出即可。agent 借助 automations skill 先预览排期再创建任务。创建、替换和删除须由人在确认卡上确认后才生效，模型不能代为确认；暂停与恢复立即生效。
- 可以让 agent 查询和管理任务，也可以使用手动 `/auto` 聊天命令和看板。
- 任务按 profile 保存在 `<data-root>/profiles/<profile>/` 下。定时运行可以读取插件，但不能自行创建或修改排期。

操作回执、恢复方式和所需事件订阅见 [运行指南](docs/operations.md#automation-operation-recovery)。

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
