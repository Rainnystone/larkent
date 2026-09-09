# lark-channel-bridge (for Grok Bot)

A bridge that puts CLI coding agents behind Feishu/Lark bots. One machine (a VPS, or a Grok Bot cloud computer) can run a **profile** in the foreground with `run`, as its own **per-profile service**, or under one supervisor via `run --web-ui` / `start --web-ui`. The supervisor console starts the active profile and lets you start the others on demand. Each profile is one Feishu bot backed by one **agent**. Grok Bot is the deployment target (a SpaceXAI always-on teammate with its own cloud computer). It is not an agent. Grok Build is an agent, one of five, with no special standing. The five peers are `claude`, `codex`, `kimi`, `grok`, and `cursor`. There is no default agent.

This README is the runbook for **Grok Bot**. Every step is a command plus a checkable result. Decision points that need a human are marked **HUMAN**. Chinese: [README.zh.md](./README.zh.md).

Not published to npm. Install from source.

## Pick an agent

| Agent | `--agent` | Binary | Headless call | Resume flag | Host must reach |
|---|---|---|---|---|---|
| **Claude Code** | `claude` | `claude` | `claude -p --output-format stream-json` | `--resume` | Anthropic |
| **Codex CLI** | `codex` | `codex` | `codex exec --json` | `resume` | OpenAI |
| **Kimi Code** | `kimi` | `kimi` | `kimi -p --output-format stream-json` | `-S` | Moonshot endpoints |
| **Grok Build** | `grok` | `grok` | `grok -p --output-format streaming-json --always-approve` | `-r` (never `-s`) | `auth.x.ai` / grok chat proxy (**outside mainland GFW**) |
| **Cursor CLI** | `cursor` | `cursor-agent` (fallback `agent`) | `agent -p --output-format stream-json --force --sandbox disabled --approve-mcps --trust` | `--resume` | Cursor API (logged-in CLI or `CURSOR_API_KEY`) |

Do not mix agents in one profile. Create a second profile instead.

Replace `<AGENT>` below with `claude`, `codex`, `kimi`, `grok`, or `cursor`. Profile name follows the `--agent` kind. There is no default agent.

## Mental model

```
Feishu user message ──WS long connection──> this process
   │  scope = chatId (topic groups: chatId:threadId)
   ▼
spawn local CLI (claude / codex / kimi / grok / cursor-agent -p …)  →  stdout JSONL → AgentEvent
   ▼
one Feishu markdown reply (tool-call chatter hidden by default)
```

- **Runtime ownership**: each profile owns its adapter instance, identity, session
  state and active runs. Adapters share the process runner implementation, while
  each run owns its subprocess and translator state. Runtime isolation does not
  isolate files in a working directory shared by multiple profiles.
- **Storage**: profiles use schema v3; `sessions.json` and `workspaces.json` use
  v2, as does the session catalog. SessionStore v2 stores `resumeHandle` in an
  `entries` map and retains per-scope idle preferences. Workspace v2 retains
  `chats` and `named` mappings. Supported legacy files upgrade on load; a Git
  rollback also needs a matching data backup, not just an older executable.
- **Sessions**: catalog under `~/.lark-channel/profiles/<profile>/`; native
  Grok sessions under `~/.grok/sessions/`. One CLI process per message batch.
- **Speak vs read**: chat output is always the **bot**. Reading group history,
  docs, sheets, and other tenant assets uses `lark-cli --as user` after a
  one-time owner OAuth. Tokens live in the **profile-local lark-cli directory**,
  not in a hung agent run. Restarting the bridge does not require a login
  process to be running.
- **First-init defaults** (written on `run` / `start`, do not hand-tune unless
  asked): `mode: team`, `showToolCalls: false`,
  `larkCli.identityPreset: user-default`, lark-cli `strict-mode off` +
  `default-as bot`.

## Host constraints

- Node.js ≥ 20.12, a writable `$HOME`, outbound HTTPS.
- **Claude Code**: needs Anthropic. Does not need xAI.
- **Codex CLI**: needs OpenAI. Does not need xAI.
- **Grok Build**: the machine must resolve and TLS to xAI. Mainland China
  hosts fail even if a human completed device-code on another device. Do not
  put a Grok profile on a GFW-side VPS.
- **Kimi Code**: does not need xAI; still needs Feishu `open.feishu.cn`.
- **Cursor CLI**: needs the Cursor API (logged-in CLI or `CURSOR_API_KEY`). Does not need xAI.
- Do **not** set `GROK_HOME` / isolate `~/.grok` for the bot — inherit the
  logged-in `auth.json`. Same for Claude (`~/.claude`), Codex (`~/.codex`),
  Kimi (`~/.kimi-code`), and Cursor (inherit the logged-in CLI / `CURSOR_API_KEY`).
  Isolating the home forces a second login.
- Do **not** set `XAI_API_KEY` if the owner wants SuperGrok quota.

## Prerequisites (verify before install)

| Requirement | Check | Pass |
|---|---|---|
| Node ≥ 20.12 | `node --version` | `v20.12.0` or newer |
| pnpm | `npx pnpm --version` | any 10.x |
| lark-cli | `lark-cli --version` | e.g. `1.0.x` |
| Claude (if `--agent claude`) | `claude --version` | Claude Code version banner |
| Codex (if `--agent codex`) | `codex --version` | Codex CLI version banner |
| Grok (if `--agent grok`) | `grok --version` then `test -f ~/.grok/auth.json` | binary + auth file |
| Kimi (if `--agent kimi`) | `kimi -p "say OK" --output-format stream-json` | JSONL, exit 0 |
| Cursor (if `--agent cursor`) | `cursor-agent --version` or `agent --version` | Cursor CLI version banner |
| TTY | `[ -t 0 ] && [ -t 1 ] && echo tty` | `tty` — required for QR wizard |

**HUMAN — agent login (once per host):**

- Claude: `claude` (complete the Anthropic login in the CLI).
- Codex: `codex login`.
- Grok: `grok login --device-auth` (print URL + code; owner confirms on any device).
- Kimi: `kimi login`.
- Cursor: `agent login` (or set `CURSOR_API_KEY`).

Install Claude Code: `npm install -g @anthropic-ai/claude-code`.
Install Codex CLI: `npm install -g @openai/codex`.
Install Grok CLI: `curl -fsSL https://x.ai/cli/install.sh | bash`.
Install Cursor CLI: `curl https://cursor.com/install -fsS | bash` (binary is `agent`; add `~/.local/bin` to PATH). If the binary is `agent` not `cursor-agent`, set `LARK_CHANNEL_CURSOR_BIN=agent`.
Install lark-cli if missing: `npm install -g @larksuite/cli`.

## Install

```bash
git clone https://github.com/Rainnystone/larkent-for-grokbot.git
cd larkent-for-grokbot
npx pnpm install        # prepare also builds dist/
npx pnpm build          # after any source change
```

Entry point: `node bin/lark-channel-bridge.mjs <command>` from the repo root.

## Provision the Feishu app

**HUMAN.** Creates a Feishu/Lark application. Prefer path B when this process
has no TTY (Grok Bot cloud shells often do not).

**A. QR wizard (TTY required):**

```bash
node bin/lark-channel-bridge.mjs run --agent <AGENT>
```

Prints a QR and a URL. Owner scans with the Feishu mobile app. Wait until
stdout contains `✓ 应用创建成功` then `正在监听消息`.

If stdin is not a TTY, do not attempt A. Use B.

**B. Existing app credentials (scriptable):**

```bash
node bin/lark-channel-bridge.mjs run --agent <AGENT> \
  --app-id cli_xxx --app-secret <secret> --tenant feishu
```

Use `--tenant lark` for Lark global. Ask the owner for id/secret; do not invent
them. Stop with Ctrl-C after `正在监听消息` if you only needed config written.

Config: `~/.lark-channel/config.json` (`LARK_CHANNEL_HOME` overrides the root).
Secrets go to the per-profile keystore, not the JSON file.

## Owner OAuth (CLI — not inside a coding-agent turn)

Needed before the bot can read group history or edit tenant docs. Tokens are
stored in the **profile-local lark-cli directory**. This is a first-init step,
not a leftover `grok`/`kimi` process.

**HUMAN** opens `verification_url` (10 min TTL). Run in the **foreground**;
do not background the device-code wait.

```bash
export LARK_CHANNEL=1 LARK_CHANNEL_HOME=~/.lark-channel LARK_CHANNEL_PROFILE=<AGENT> \
  LARK_CHANNEL_CONFIG=~/.lark-channel/profiles/<AGENT>/lark-cli-source/config.json \
  LARKSUITE_CLI_CONFIG_DIR=~/.lark-channel/profiles/<AGENT>/lark-cli

lark-cli auth login --no-wait --json --domain im,docs,drive,wiki,sheets,base,markdown,task,calendar
# print verification_url + device_code to the owner
lark-cli auth login --device-code "<device_code>"
lark-cli config strict-mode off && lark-cli config default-as bot
lark-cli auth status --json
# pass: identities.user.status == "ready", identities.bot.status == "ready", defaultAs == "bot"
```

This is the **lark-cli identity policy**: speak as bot; `--as user` only for
reads/assets. Never send an OAuth URL into a group (whoever clicks binds the
token).

## Run

Foreground check:

```bash
node bin/lark-channel-bridge.mjs run --agent <AGENT>
# pass: "✓ 已连接  bot: <name> ... agent: Grok Build (grok)"  / "Kimi Code (kimi)" / "Cursor CLI (cursor)"
# then "正在监听消息"
```

Then install as an OS **per-profile service** (launchd on macOS, systemd
`--user` on Linux). On Windows the unit is a `.cmd` wrapper via schtasks.

```bash
node bin/lark-channel-bridge.mjs start
node bin/lark-channel-bridge.mjs ps
node bin/lark-channel-bridge.mjs status
node bin/lark-channel-bridge.mjs restart
node bin/lark-channel-bridge.mjs stop
```

Plain `start` is one **per-profile service**. To host every profile in one
machine-wide supervisor (local web console), use `start --web-ui` /
`run --web-ui` instead.

Headless Linux: `loginctl enable-linger "$USER"` or the user unit dies at logout.

## Verify

1. Feishu DM (or group `@bot`): `用一句话介绍你自己`.
   Pass: one markdown reply in ~30 s, no tool-call rows
   (`showToolCalls: false`).
2. After owner OAuth: `回顾一下这个群最近的聊天记录`.
   Pass: answers using the owner's user identity; chat still shows the bot.
3. Foreground profile logs: `~/.lark-channel/profiles/<profile>/logs/bridge-YYYYMMDD.jsonl`
   (`"phase":"run"` / `"event":"completed"`). Supervisor console logs use
   `~/.lark-channel/logs/`. Daemon `status --profile <profile>` / `status --web-ui`
   reports its stdout/stderr paths. Foreground processes stop with Ctrl-C;
   `stop` and `restart` control OS services. There is no `logs` subcommand.

## Configuration reference

`~/.lark-channel/config.json` → `profiles.<name>`:

| Key | Default | Meaning |
|---|---|---|
| `agentKind` | `--agent` kind. There is no default. | adapter |
| `mode` | `team` | `team` = anyone who can reach the bot; `personal` = allowlists |
| `access.allowedUsers/allowedChats/admins` | `[]` | personal mode; admins also in team |
| `workspaces.default` | profile workspace | `/cd` default |
| `preferences.model` | unset | `grok -m` / `kimi -m` / `cursor --model` |
| `preferences.showToolCalls` | `false` | hide tool-call progress |
| `larkCli.identityPreset` | `user-default` | user identity allowed; default identity stays bot |

Canonical permissions (legacy `sandbox` is still accepted on read, then
normalized away — do not add new sandbox keys):

```json
"permissions": {
  "defaultAccess": "full",
  "maxAccess": "full"
}
```

In-chat: `/help` `/status` `/config` `/cd <path>` `/new` `/stop` `/resume`
`/invite user` `/remove user` `/invite group` `/remove group`
`/invite all group` `/invite admin`.

Profile CLI: `profile export`, `profile remove --purge --yes`,
`profile export --include-secrets --yes`.

Env: `LARK_CHANNEL_HOME`, `LARK_CHANNEL_GROK_BIN`, `LARK_CHANNEL_KIMI_BIN`, `LARK_CHANNEL_CURSOR_BIN`.
The binary variables are resolved into `agent.binaryPath` when creating a new
profile. An existing profile keeps its stored binary path; changing only an env
variable does not override it. Changing the bridge data root does not change
`HOME` or the coding CLI login.

Cloud-doc comments are document-scoped: `@bot` on a Feishu doc comment uses
that document's session, not the IM allowlist.

## Troubleshooting

| Symptom | Diagnosis | Fix |
|---|---|---|
| QR wizard errors about non-interactive mode | no TTY | use `--app-id` / `--app-secret` |
| `agent-binary-not-found` | CLI missing or not on PATH | install/login; or `LARK_CHANNEL_GROK_BIN` / `LARK_CHANNEL_KIMI_BIN` / `LARK_CHANNEL_CURSOR_BIN` |
| Grok auth fails on the server | host cannot reach xAI | move the process off the GFW |
| Resume is a blank Grok session | used `-s` | adapter uses `-r` only |
| `230027` on group history | bot lacks the scope | expected until owner OAuth; then `--as user` |
| OAuth URL expired | 10 min TTL | `auth login --no-wait` again |
| Linux service dies after logout | systemd user unit | `loginctl enable-linger "$USER"` |
| Tool rows in Feishu | `showToolCalls` true | `/config` hide, or this fork default is already false |

## Development

```bash
npx pnpm typecheck
npx pnpm test
npx pnpm build
GROK_REAL_SMOKE=1 npx vitest run tests/process/grok-real.smoke.test.ts
KIMI_REAL_SMOKE=1 npx vitest run tests/process/kimi-real.smoke.test.ts
CURSOR_REAL_SMOKE=1 npx vitest run tests/process/cursor-real.smoke.test.ts
```

The descriptor registry in `src/agent/registry.ts` is the single production
registration source for creation, capabilities, detection and UI choices. Each
adapter owns its metadata, factory, protocol, options and history behavior;
resume flags, image support and native history remain adapter-specific. Tests
independently pin all five supported kinds.

The bot owns business idle timing and pauses it during tool execution. The
executor owns profile/scope run registration and bounded settlement after a
terminal event. The runner owns subprocess I/O, exit, stop and cleanup;
`stop()` succeeds only after exit and adapter cleanup. Ownership is released
only after successful settlement; cleanup failures remain observable.

Adapters: `src/agent/claude/`, `src/agent/codex/`, `src/agent/kimi/`, `src/agent/grok/`, `src/agent/cursor/`. Channel,
cards, sessions, daemon, web console are agent-agnostic. Shared bot/card code
must not import adapter internals (`tests/static/contracts.test.ts`).

## License

MIT (inherited from upstream).
