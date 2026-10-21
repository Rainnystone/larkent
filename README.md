# Larkent: Agent for lark

Bring your coding agents into Feishu / Lark. Larkent connects conversations to Claude Code, Codex CLI, Kimi Code, Grok Build, Cursor CLI, and Antigravity CLI running on your own machine or server.

Inspired by [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge), Larkent has since undergone an architectural refactor: a shared agent registry and process runner, independent bot profiles, and consistent session and lifecycle handling across multiple CLIs.

[中文说明](README.zh.md)

## What Larkent does

- **Work from chat.** Message a bot directly or mention it in a group to ask questions, inspect a project, or run a coding task.
- **Keep the conversation going.** Continue a session, switch workspaces, stop a task, and resume later.
- **Run multiple agents.** Give each bot its own CLI, configuration, sessions, and runtime state. Multiple profiles can run on the same host.
- **Use your Lark context.** Read wiki pages, documents, and chat history with the owner's authorized user identity. Replies still come from the bot.
- **Schedule work.** Create confirmed reminders and agent tasks that run on a schedule.
- **Choose how to run it.** Start in a terminal, use a background service, or manage profiles through the local web console.

## Supported agents

| Agent | Profile kind | CLI executable |
| --- | --- | --- |
| Claude Code | `claude` | `claude` |
| Codex CLI | `codex` | `codex` |
| Kimi Code | `kimi` | `kimi` |
| Grok Build | `grok` | `grok` |
| Cursor CLI | `cursor` | `cursor-agent` or Cursor's `agent` |
| Antigravity CLI | `antigravity` | `agy` |

All six use the same runtime contracts. CLI-specific options, image handling, and native history support remain adapter-specific. Select the agent explicitly when creating a profile.

## Requirements

- Node.js 20.12 or newer and pnpm matching the version in [package.json](package.json).
- At least one supported coding CLI installed and logged in.
- [Lark CLI](https://github.com/larksuite/cli) installed.
- A Feishu / Lark account that can register an application or authorize an existing one.
- Network access from the host to Feishu / Lark and the selected CLI's provider.

Keep the coding CLI's existing login environment. Larkent stores its own profile data separately.

## Quick start

Install from source:

```sh
git clone https://github.com/Rainnystone/larkent.git
cd larkent
pnpm install --frozen-lockfile
pnpm build
```

Create a profile. This example uses Codex; replace `codex` with the kind of the CLI you want to connect:

```sh
node bin/lark-channel-bridge.mjs profile create my-agent --agent codex
node bin/lark-channel-bridge.mjs run --profile my-agent
```

Follow the application registration prompts in a terminal with TTY support. For an existing application, pass `--app-id` and enter its secret when prompted. Add `--tenant lark` for Lark global.

**Complete owner authorization during first setup.** App registration is only one part of setup. The setup agent must also ask the owner to complete full user-identity OAuth with `--domain all`, within this profile's environment. Then verify a real wiki/document read and a read from another chat the owner can access. Valid authorization is reused after restarts.

Follow the [agent setup guide](docs/agent-setup.md) for the complete registration, authorization, and verification flow. Agents setting up this repository should start with [AGENTS.md](AGENTS.md).

Once setup is complete, send the bot a direct message or mention it in a group. Stop the foreground process with `Ctrl-C`.

## Bridge plugins and skills

Agent CLIs only know what their own tooling and native plugins teach them. The bridge exposes its own tools, such as automation scheduling, through a shared JSON client, but a CLI has no built-in way to discover that client or its contract, so on its own it would not reliably call it. Bridge plugins close that gap independently of any particular CLI.

- Every IM run, including resumed sessions and scheduled agent runs, receives short package summaries and the common tool contract. Full skill bodies and resources are read on demand through the bridge tool (`plugins.list` / `plugins.inspect` / `plugins.read`).
- The built-in [`plugins/automation`](plugins/automation/) package ships the automations skill, so every supported CLI learns the same automation contract.
- Operators can add more packages by listing absolute package roots in `<data-root>/plugins.json`, shared by the profiles under that data root. Bridge plugins are separate from each CLI's native plugins: the bridge does not install, download, host MCP/hooks, or change CLI trust, and it returns scripts without running them.

Manifest format, dependencies, diagnostics, and updates are covered in [External bridge plugins](docs/operations.md#external-bridge-plugins).

## Automations

With `automations.enabled`, a bot can run scheduled tasks in a chat: **reminders** deliver their text when they come due, and **agent tasks** (when `automations.agentTasks` is enabled) run the agent in the working directory captured at creation, using the profile's existing authorization.

- Ask in natural language. The agent uses the automations skill to preview the schedule, then creates the task. Create, replace, and delete only take effect after a human confirms the card; the model cannot confirm for you. Pause and resume apply immediately.
- List and manage tasks by asking the agent, or with the manual `/auto` chat commands and dashboard.
- Tasks are stored per profile under `<data-root>/profiles/<profile>/`. Scheduled runs can read plugins but cannot create or change schedules themselves.

See the [operations guide](docs/operations.md#automation-operation-recovery) for operation receipts, recovery, and required event subscriptions.

## Running and configuration

Use the [operations guide](docs/operations.md) for background services, the web console, chat commands, configuration, logs, and troubleshooting. Self-heal after sleep, restart, or a WebSocket blip is in the [Self-heal](docs/operations.md#self-heal) section.

The executable retains its existing filename, `bin/lark-channel-bridge.mjs`. The default data directory is `$HOME/.lark-channel`; set `LARK_CHANNEL_HOME` to use another location. Each profile keeps its own credentials and session state. Runtime isolation does not isolate files in a workspace shared by multiple agents.

## Development

```sh
pnpm ci:local
```

This runs the repository's diff checks, tests, type checking, and build. Real CLI smoke tests require their corresponding installed CLI and explicit environment switches; see the [operations guide](docs/operations.md#development-checks).

- [Agent setup](docs/agent-setup.md)
- [Runtime terminology](CONTEXT.md)
- [Agent adapters](src/agent/)
- [Runtime implementation](src/runtime/)

## Acknowledgments and license

Thanks to [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) for the original inspiration and foundation.

Larkent is distributed under the [MIT License](LICENSE). The original copyright notice is retained.
