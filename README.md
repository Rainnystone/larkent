# Larkent: Agent for lark

Bring your coding agents into Feishu / Lark. Larkent connects conversations to Claude Code, Codex CLI, Kimi Code, Grok Build, Cursor CLI, and Antigravity CLI running on your own machine or server.

Inspired by [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge), Larkent has since undergone an architectural refactor: a shared agent registry and process runner, independent bot profiles, and consistent session and lifecycle handling across multiple CLIs.

**English** | [简体中文](README.zh.md)

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

Each coding CLI only knows the tools its own setup gives it. Larkent has extra abilities of its own, such as scheduling tasks, but a CLI cannot find or call them by itself. Bridge plugins solve this in one place for every supported CLI: they are packages of skills (plain `SKILL.md` instructions plus optional references and scripts) that the bridge hands to whichever agent is running.

**How it works**

1. You do not install anything per CLI. On every chat run, including resumed sessions and scheduled agent runs, the bridge tells the agent which plugins are available and how to call the bridge's tool client.
2. When the agent needs a skill, it reads the full instructions on demand through that client.
3. The built-in [`plugins/automation`](plugins/automation/) package ships with Larkent and is always available, so every CLI knows how to work with automations out of the box.

**Adding your own plugins (optional)**

1. Prepare each plugin as a directory on the host, with a `.codex-plugin/plugin.json` manifest and its skill folders.
2. Create `plugins.json` in the data directory (`$HOME/.lark-channel` by default) and list each plugin's absolute path:

   ```json
   { "schemaVersion": 1, "packages": ["/srv/larkent-plugins/my-plugin-v1"] }
   ```

3. Restart the profiles. All profiles using that data directory share the list.

Bridge plugins are separate from a CLI's own native plugins. The bridge does not download or install anything, does not host MCP servers or hooks, does not change the CLI's trust settings, and does not run plugin scripts for the agent. See [External bridge plugins](docs/operations.md#external-bridge-plugins) for the manifest format, dependencies, diagnostics, and updating to a new version.

## Automations

Automations let a bot do things on a schedule in a group chat:

- **Reminders** post a message when they come due.
- **Agent tasks** run the agent at the scheduled time, in the working directory that was set when the task was created, using the profile's existing authorization.

**Turn it on**

Set `automations.enabled` to `true` for the profile in `config.json` (see [Configuration and identity](docs/operations.md#configuration-and-identity)). To allow agent tasks, also set `automations.agentTasks`. `automations.timezone` defaults to the host machine's local time zone (UTC if it cannot be detected); set it to an IANA name such as `Europe/London` or `America/New_York` to use a different zone. Restart the profile afterwards. Automations work in group chats only.

**Create a task by just asking**

1. Mention the bot in a group and describe what you want, for example:
   - "@bot remind me at 09:00 every day today, tomorrow, and the day after to check the build"
   - "@bot every weekday at 18:00 summarize today's commits in this repo" (an agent task; set the working directory first with `/cd`)
2. The agent previews the schedule and sends a **confirmation card** showing the task type, name, schedule, time zone, the next few run times, the end time, the task text, and who it runs as.
3. Click **Yes** (labeled 是 on the card) to save it, or **No** (labeled 否) to cancel. Nothing is saved until a person confirms; the agent cannot confirm for you.
4. Recurring tasks need an end time. If you did not give one, the bot sends a card with quick choices (one week, two weeks, one month, three months, end of year, one year) before the confirmation card.

The earliest start is 10 minutes from now, and a one-time task can be at most a year ahead.

**View and manage tasks**

- Ask the agent: "@bot what scheduled tasks does this group have?", "pause the daily build reminder", "delete task 3".
- Pause and resume take effect immediately. Delete and replace send a confirmation card first.
- Or use chat commands: `/auto list`, `/auto pause <id>`, `/auto resume <id>`, `/auto delete <id>`, and `/auto new <schedule> | <name> | <text>` (`/auto new agent ...` for an agent task).

Tasks are saved per profile under the data directory and survive restarts. A scheduled agent run can use plugins but cannot create or change schedules itself. For operation receipts, recovery, and the Feishu events to subscribe to, see the [operations guide](docs/operations.md#automations-events).

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
