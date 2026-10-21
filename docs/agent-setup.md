# Agent setup: first Feishu connection

For agents performing deployment or connection tasks. Applies to Claude Code, Codex CLI, Kimi Code, Grok Build, Cursor CLI, Antigravity CLI, and Devin CLI.

First-time setup of each profile has three parts:

1. Local coding CLI login.
2. Feishu app registration and regular authorization.
3. The owner's full user-identity OAuth.

You must actively ask the user to complete part 3, then verify reading wiki/docs and chat history from other groups. Do not report "setup complete" just because the bot is online.

User-identity authorization is stored in the current profile's lark-cli directory. Normal restarts reuse a valid authorization. Re-authorize only for a new profile, an expired or revoked authorization, or an actual missing permission. It is not the machine-global lark-cli login, and not the coding CLI's model account login.

## 1. Check environment and install

1. Verify the user-specified source version and worktree with `git rev-parse --show-toplevel`, `git branch --show-current`, and `git status --short`.
2. Check the target CLI, login, network, Node, and pnpm against [README requirements](../README.md#requirements). `package.json` is authoritative for versions. When continuing from existing source, use the current checkout as is.
   - The Antigravity CLI executable is `agy` (`agy --version`). Do not use `antigravity` or Gemini CLI.
   - Verify that Cursor's `agent` is actually Cursor CLI.
   - The Devin CLI executable is `devin` (`devin --version`); this adapter requires its native stdio ACP entry point (`devin acp --help`). Local adapter smoke was verified with 3000.11.92; this is a tested version, not a guessed minimum.
3. Run `pnpm install --frozen-lockfile`, then `pnpm build`, then check `node bin/lark-channel-bridge.mjs --help`. Use this checkout's local entry point from now on.

**Completion criteria:** dependencies and build succeed; the target CLI is logged in and runs. Record the actual CLI version, source branch/SHA, and code directory.

### Optional: host-level bridge plugins

A maintainer can prepare local packages or Git checkouts at a fixed revision on the host and list their absolute paths in `plugins.json` in the data root. Profiles in the same deployment share this installation config by default; no per-profile enabling is needed. For the full manifest subset, dependency declarations, reading, and update steps, see [operations](operations.md#external-bridge-plugins). This is separate from the CLI's own native plugins: the bridge does not scan or inherit their global installs. Do not raise the CLI's access mode to read bridge plugins.

For first acceptance, record separately:

- The catalog's actual available scope.
- Skill/reference read results.
- Actual output of the runtime's existing tools running a benign script from the package.

Discovering files alone does not prove command dependencies, platform authorization, or real model tool selection work. Adding a plugin does not require reconfiguring profile credentials. If a command or authorization is missing, hand it to the maintainer; the chat agent does not install or log in.

## 2. Register and start the target profile

Complete QR-code registration or existing-app configuration per [Quick start](../README.md#quick-start). For a custom profile, use `profile create <name> --agent <kind> --workspace <path>`; check local `profile create --help` for arguments first. Record the actual data root and profile name used. The profile name may differ from the agent kind.

Start in the foreground first and wait for profile preflight, app binding, and connection to complete:

```sh
LARK_CHANNEL_HOME=<actual-data-root> node bin/lark-channel-bridge.mjs run --profile <actual-profile-name>
```

QR-code flows that need a TTY require a real terminal or the agent tool's PTY. Do the next step's OAuth in another terminal and let the user confirm authorization privately.

**Completion criteria:** the connection message's bot, profile, and agent match the target; the bridge has initialized the profile's `lark-cli/` and `lark-cli-source/config.json`. Then continue to user-identity authorization.

## 3. Request one full user-identity authorization

Tell the user: "App registration is complete. First-time setup also needs you to complete one full user-identity authorization for this bot, so it can read wiki pages, documents, and chat history from other groups that you can access. The bot still speaks as the bot after authorization."

In the setup agent's terminal, set both variables to **the profile you just started**. A custom test data root must not reuse the default directory. The helper function makes every lark-cli command use the same profile; do not bind the token to the machine-global config.

```sh
LARKENT_DATA_ROOT="$HOME/.lark-channel"
LARKENT_PROFILE='<actual-profile-name>'

larkent_lark() {
  env LARK_CHANNEL=1 \
    LARK_CHANNEL_HOME="$LARKENT_DATA_ROOT" \
    LARK_CHANNEL_PROFILE="$LARKENT_PROFILE" \
    LARK_CHANNEL_CONFIG="$LARKENT_DATA_ROOT/profiles/$LARKENT_PROFILE/lark-cli-source/config.json" \
    LARKSUITE_CLI_CONFIG_DIR="$LARKENT_DATA_ROOT/profiles/$LARKENT_PROFILE/lark-cli" \
    lark-cli "$@"
}

larkent_lark auth login --help
larkent_lark auth status --json --verify
```

If a complete, valid user authorization belonging to the target owner already exists, check its actual scopes and reuse it. Otherwise start a full authorization:

```sh
larkent_lark auth login --domain all --no-wait --json
```

`--domain all` requests user permissions for every business domain the current lark-cli supports. `--recommend` requests only recommended permissions. IM-only, wiki-only, or other partial scopes do not count as this project's full first-time authorization. Both app-console permissions and owner authorization must be satisfied. If an item needs admin approval or cannot be granted, record what is missing and ask the user to do the console action actually needed. Do not report a narrowed scope as full success. Full authorization does not widen the owner's existing resource visibility.

Complete the device flow in this order:

1. Take `verification_url` and `device_code` from this response. Show the raw URL and QR code to the correct owner in a private local conversation or a DM with the bot. Never post the authorization link in a group. Keep the device code private to the setup agent.
2. Generate the QR code with `larkent_lark auth qrcode <verification_url> --output <relative-png-path>`, run in a private directory so authorization material never lands in the source tree. After confirming the user can see the link, have the user authorize.
3. If the harness shows replies only at the end of the turn, hand back control first. After the user replies that authorization is done, run the continuation commands below. Do not block waiting while the link is not yet visible, and do not put the wait process in a background job that is reaped when the turn ends.

```sh
larkent_lark auth login --device-code '<device_code-from-this-response>'
larkent_lark config strict-mode off
larkent_lark config default-as bot
larkent_lark auth status --json --verify
```

Run these in order; on failure, keep the specific reason. If the link expires, restart with the same `--domain all --no-wait --json`; never reuse an expired code. Tell the user only the authorization and verification results; the setup agent runs the internal config commands.

**Completion criteria:** confirm the target owner, `identities.user.status == "ready"`, the online verification result of the user token, and the actually granted scopes; also confirm the bot identity works and `defaultAs == "bot"`. Only generating a link, only completing app QR registration, or seeing user ready without checking granted scopes does not complete this step.

## 4. Verify identity and real access

Run all reads in the profile environment above. Choose specific business commands from the relevant skill or local `--help`; add `--as user` explicitly for user-resource reads.

- Feishu message round trip: the user `@bot`s in a DM or the target group and gets an actual reply from the target CLI. Messages, cards, and replies stay in bot identity.
- Wiki/docs: read an actual wiki page or document that the user names and can access, and check the returned content. An empty list or the bot's own resources do not prove success.
- Cross-group chat history: in another group the user names and the owner can access, read a known stretch of history using user identity, and confirm it came from that group. A user token does not mean any group can be read.
- Continue, stop, resume, and restart: verify within this connection's scope. Confirm the profile's user authorization still works after restart without depending on the earlier login process.

If no usable page or group is available for verification, ask the user for the minimum test targets. For permission errors, first distinguish app scope, user scope, token state, and resource visibility. Keep the actual error and missing condition; after fixing, retry the original read.

**Completion criteria:** record the profile, CLI version, bot round trip, full user authorization, and the results of both kinds of real reads. Keep tokens, secrets, device codes, and authorization QR codes in a private environment; deliver only redacted evidence. Mark unverified capabilities explicitly. Do not claim setup is complete based only on successful registration or passing automated tests.

## Next steps as needed

- Always-on services, supervisor, stopping, and logs: [operations](operations.md).
- Using automations and bridge plugins: [README](../README.md#automations).
- Connection problems that need code changes: leave the regression test and fix on the user-specified branch/worktree and run the repo's `pnpm ci:local`. Record the actual commands, exit codes, and real-scenario re-verification results.
