# lark-channel-bridge (Kimi Code fork)

A bridge that connects Feishu / Lark messenger to a local **Kimi Code** CLI.
Users DM the bot or `@`-mention it in a group; the bridge runs `kimi -p` and
posts the agent's answer back to the chat.

This repository is a fork of `lark-channel-bridge` (upstream supports Claude
Code and Codex CLI; those code paths are intact but not the focus here). It is
**not published to npm** — install from source.

This README is written to be executable by an autonomous agent (e.g. an
always-on AI teammate such as Grok Bot) deploying on a headless Linux host:
every step is a command with a verifiable result, and decision points are
explicit. Chinese version: [README.zh.md](./README.zh.md).

## Mental model

```
Feishu user message ──WS long connection──> bridge (this repo)
   │  scope = chatId (or chatId:threadId in topic groups)
   ▼
spawn `kimi -p "<prompt>" --output-format stream-json`  (+ `-S <sessionId>` on later turns)
   │  stdout JSONL → AgentEvents (system / tool_use / tool_result / final_text / done)
   ▼
Feishu reply (markdown by default; one clean final message per turn)
```

- **Sessions**: one Kimi session per scope, persisted under
  `~/.lark-channel/profiles/<profile>/`. A new `kimi` process is spawned per
  message batch and resumed with `-S`; context survives across turns.
- **Access**: this fork defaults to `mode: team` — anyone who can reach the
  bot may use it. Admin commands (`/invite`, `/config`, …) stay owner-only.
- **Identity**: the bot always *speaks* as the bot. For reading chat history,
  search, docs/sheets and other tenant assets, the agent calls `lark-cli`
  with `--as user` after the owner completes a one-time OAuth device login.
  lark-cli policy is `strict-mode off` + `default-as bot` (fork default).

## Prerequisites

| Requirement | Check command | Expected |
|---|---|---|
| Node.js ≥ 20.12 | `node --version` | `v20.12.0` or newer |
| pnpm (via npx is fine) | `npx pnpm --version` | any 10.x |
| Kimi Code CLI, logged in | `kimi -p "say OK" --output-format stream-json` | JSONL on stdout, exit 0 |
| lark-cli | `lark-cli --version` | e.g. `1.0.x` |
| Feishu/Lark app credentials | — | obtained in the provisioning step below |

If `kimi` is not logged in: `kimi login` (device-code flow, needs a browser).

## Install from source

```bash
git clone <this-repo-url> && cd lark-channel-bridge   # or unpack the tarball
npx pnpm install        # also builds dist/ via the prepare script
npx pnpm build          # rerun after any source change
```

The CLI entry point is `bin/lark-channel-bridge.mjs`; commands below are run
as `node bin/lark-channel-bridge.mjs <command>` from the repo root
(optionally `npx pnpm link --global` to get a `lark-channel-bridge` binary).

## Provision the Feishu app

Two paths; **path B is the scriptable one** for unattended deploys. Both end
with the bridge running in the foreground — stop it after config is written
(Ctrl-C) if you only wanted provisioning.

**A. QR wizard (needs a human with the Feishu mobile app, once):**

```bash
node bin/lark-channel-bridge.mjs run --agent kimi
```

The wizard requires a TTY. In non-TTY environments use the bundled helper,
which prints a plain URL for a human to open and writes credentials to JSON:

```bash
node scripts/register-app.mjs /tmp/app.json   # prints QR_URL=..., exits after confirmation
# then continue with path B using the values in /tmp/app.json; delete the file afterwards
```

**B. Existing app credentials (fully non-interactive):**

```bash
node bin/lark-channel-bridge.mjs run --agent kimi \
  --app-id cli_xxx --app-secret <secret> --tenant feishu   # use --tenant lark for Lark global
```

Config lands in `~/.lark-channel/config.json` (override the root with
`LARK_CHANNEL_HOME`). Secrets go to an encrypted per-profile keystore, not
the JSON file.

## Run

Validate in the foreground first:

```bash
node bin/lark-channel-bridge.mjs run
# expected tail: "✓ 已连接  bot: <name> ... agent: Kimi Code (kimi)" then "正在监听消息"
```

Then install as an OS service (self-healing, auto-start):

```bash
node bin/lark-channel-bridge.mjs start    # launchd on macOS, systemd --user on Linux
node bin/lark-channel-bridge.mjs ps       # list running bots
node bin/lark-channel-bridge.mjs status   # service status
node bin/lark-channel-bridge.mjs restart  # apply config changes
node bin/lark-channel-bridge.mjs stop     # stop service
```

Linux note: the service is a **systemd user unit** (`Restart=always`,
`RestartSec=5`, `WantedBy=default.target`). On a headless server where nobody
stays logged in, run once:

```bash
loginctl enable-linger "$USER"
```

otherwise the user service is torn down at logout.

## Verify the deployment

1. In Feishu, DM the bot (or `@bot` in a group): `用一句话介绍你自己`.
   Expected: one markdown reply within ~30 s, no tool-call chatter
   (`showToolCalls: false` in this fork's default profile).
2. After the OAuth step below, ask: `回顾一下这个群最近的聊天记录`.
   Expected: it answers using the owner's user identity.
3. Logs: `~/.lark-channel/profiles/kimi/logs/bridge-YYYYMMDD.jsonl`
   (JSONL; grep `"phase":"run"` / `"event":"completed"`).

## One-time owner OAuth (reading history / editing tenant assets)

Run with the profile's lark-cli environment (adjust `~` if
`LARK_CHANNEL_HOME` is overridden):

```bash
export LARK_CHANNEL=1 LARK_CHANNEL_HOME=~/.lark-channel LARK_CHANNEL_PROFILE=kimi \
  LARK_CHANNEL_CONFIG=~/.lark-channel/profiles/kimi/lark-cli-source/config.json \
  LARKSUITE_CLI_CONFIG_DIR=~/.lark-channel/profiles/kimi/lark-cli

lark-cli auth login --no-wait --json --domain im,docs,drive,wiki,sheets,base,markdown,task,calendar
# prints verification_url (10 min TTL) + device_code — give the URL to the owner
lark-cli auth login --device-code "<device_code>"   # blocks until the owner confirms
lark-cli config strict-mode off && lark-cli config default-as bot
lark-cli auth status --json   # expect identities.user.status == "ready", defaultAs == "bot"
```

Identity rules the agent follows (written into its bridge system prompt):
chat output is always sent as the bot; `--as user` is used only for reading
history / search / docs / sheets / tenant-asset operations.

## Configuration reference

`~/.lark-channel/config.json` → `profiles.<name>`:

| Key | Default (this fork) | Meaning |
|---|---|---|
| `agentKind` | `kimi` | agent adapter |
| `mode` | `team` | `team` = open to everyone; `personal` = allowlists |
| `access.allowedUsers/allowedChats/admins` | `[]` | used in personal mode; admins also in team |
| `preferences.model` | unset | pinned Kimi model alias → `kimi -m` |
| `preferences.showToolCalls` | `false` | hide tool-call progress messages |
| `larkCli.identityPreset` | `user-default` | user identity available (bot stays the default) |

In-chat commands: `/help` `/status` `/config` `/cd <path>` `/new` `/stop`
`/resume` `/invite group|user @x|admin @x`.

Environment variables: `LARK_CHANNEL_HOME` (config root),
`LARK_CHANNEL_KIMI_BIN` (override the kimi binary path).

## Troubleshooting

| Symptom | Diagnosis | Fix |
|---|---|---|
| No reply at all | logs show no `intake enter` | `ps`/`status`; verify app credentials and WS connectivity |
| Run completes but no message | logs end at `progress-stream-skipped` | fixed in this fork (final-answer-only replies) — update |
| `agent-binary-not-found` | preflight fails | install/login kimi, or set `LARK_CHANNEL_KIMI_BIN` |
| `230027` reading group history | bot identity lacks the scope | expected; complete OAuth, agent uses `--as user` |
| OAuth link expired | 10 min TTL | rerun `auth login --no-wait` for a fresh URL |
| Service dead after logout (Linux) | `systemctl --user status` shows inactive | `loginctl enable-linger "$USER"` |

## Development

```bash
npx pnpm typecheck
npx pnpm test            # unit + integration + process + static contracts
KIMI_REAL_SMOKE=1 npx vitest run tests/process/kimi-real.smoke.test.ts  # real-kimi smoke (opt-in)
```

Layout: `src/agent/kimi/` is the adapter — `argv.ts` builds the CLI call,
`jsonl.ts` translates Kimi's stream-json into `AgentEvent`, `adapter.ts`
manages the child process. Everything above the adapter (channel, cards,
sessions, access, commands, daemon, web console) is agent-agnostic. Shared
bot/card code must not import agent internals — enforced by
`tests/static/contracts.test.ts`.

## License

MIT (inherited from upstream).
