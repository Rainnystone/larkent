# Larkent: Agent for lark

把你的 coding agent 接入飞书 / Lark。通过私聊或群聊，使用运行在自己电脑或服务器上的 Claude Code、Codex CLI、Kimi Code、Grok Build 和 Cursor CLI。

Larkent 受到 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 启发，并在此基础上进行了架构重构：统一 agent 注册与进程执行机制，让多个 CLI 共用运行底座，同时保持各 bot 的配置、会话和运行状态独立。

[English](README.md)

## 可以做什么

- **在聊天里处理任务。** 私聊 bot，或在群里 `@bot`，让 agent 回答问题、查看项目、执行编码任务。
- **延续工作上下文。** 连续对话、切换工作目录、停止当前任务，之后再恢复会话。
- **同时运行多个 agent。** 每个 bot 可以选择自己的 CLI，保存独立配置和会话；一台主机可运行多个 profile。
- **读取飞书中的上下文。** 使用 owner 授权的用户身份读取 wiki、文档和聊天记录，回复仍以 bot 身份发出。
- **选择运行方式。** 支持终端前台、后台服务，以及管理多个 profile 的本地 Web 控制台。

## 支持的 CLI

| Agent | Profile kind | CLI 程序 |
| --- | --- | --- |
| Claude Code | `claude` | `claude` |
| Codex CLI | `codex` | `codex` |
| Kimi Code | `kimi` | `kimi` |
| Grok Build | `grok` | `grok` |
| Cursor CLI | `cursor` | `cursor-agent` 或 Cursor 的 `agent` |

五种 CLI 遵循相同的运行契约。各自的参数、图片处理和原生历史能力由对应适配器负责；创建 profile 时明确选择 agent。

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

## 运行与配置

后台服务、Web 控制台、聊天命令、配置、日志和排错方法统一见 [运行指南](docs/operations.md)。

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
