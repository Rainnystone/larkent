# Larkent operations

Operations reference. For first install and user authorization, read [agent setup](agent-setup.md) first. Run the commands here from the current source checkout and replace `my-agent` with the actual profile name. With a custom data root, pass the same `LARK_CHANNEL_HOME` to every bridge command.

## Profiles and services

Each profile maps to one Feishu app and one CLI. Run in the foreground:

```sh
node bin/lark-channel-bridge.mjs run --profile my-agent
node bin/lark-channel-bridge.mjs profile list
node bin/lark-channel-bridge.mjs ps
```

Stop with `Ctrl-C` in the foreground terminal and wait for a clean exit, then switch to the per-profile service:

```sh
node bin/lark-channel-bridge.mjs start --profile my-agent
node bin/lark-channel-bridge.mjs status --profile my-agent
node bin/lark-channel-bridge.mjs restart --profile my-agent
node bin/lark-channel-bridge.mjs stop --profile my-agent
```

macOS uses launchd; Linux uses systemd user services; Windows uses Task Scheduler with a `.cmd` wrapper. For a Linux service to keep running after the user logs out, enable linger for that user.

## Supervisor console

```sh
node bin/lark-channel-bridge.mjs run --web-ui
```

The supervisor starts the active profile first; start the others on demand in the console. For an always-on console use `start --web-ui`; stop or restart with `stop --web-ui` / `restart --web-ui`. `ui --print` prints the local URL. Before switching modes, stop the same profile in the old mode.

## Chat commands

- Basics: `/help`, `/status`, `/config`, `/cd <path>`, `/new`, `/stop`, `/resume`.
- Access management: `/invite user`, `/remove user`, `/invite group`, `/remove group`, `/invite all group`, `/invite admin`.
- Automations (group chats only, requires `automations.enabled`): `/auto list`, `/auto pause <id>`, `/auto resume <id>`, `/auto delete <id>`, `/auto new <schedule> | <name> | <task>` (use `/auto new agent ...` for an agent task). You can also ask the agent in natural language to create or manage tasks; create, replace, and delete require a person to confirm on the confirmation card.
- `/stop` stops the current scope's task while the profile stays online; foreground `Ctrl-C` stops the whole profile.

## Automations events

When `automations.enabled` is on, the bridge handles the bot being removed from a group and group disbanding through `onRawEvent` on the existing long connection. Subscribe the app to these two events in the Feishu Open Platform (they use the same connection as meeting `vc.bot.*` events; do not open a second one):

- `im.chat.member.bot.deleted_v1`
- `im.chat.disbanded_v1`

Without the subscription, the bridge still deletes a group's tasks when a send is rejected because the bot is not in the group (`230002`) or the group was disbanded (`232009`).

Agent tasks (`automations.agentTasks`) use the bot/user identity already authorized for the current profile; the task text, applicable skills, and the operation decide which one. Existing identity choices such as `--as user` do not trigger a policy interrupt, and the former business-category restrictions (group creation, members, contacts, HR, and so on) have been retired. Platform permissions, the profile's explicit configuration, and final-reply ownership still apply. A task's `createdBy` keeps the creator; it does not switch the OAuth user.

Unattended, authentication/identity configuration changes still trigger `policy-guard`: login, logout, bind/init/remove config, setting strict-mode/default-as/risk-control, tenant-access-token write/remove, keychain-downgrade, and profile add/use/remove/rename. The guard interrupts the run, pauses the task, notifies the group, and writes a redacted audit entry (`auth-config`). Reading `auth status`, `config show`, or strict-mode/default-as without arguments counts as a status query. Tool-event checks cover common argv, command strings, wrapper commands, and tool names, but an event may appear only after the command ran. The agent still has a full shell; this is not host permission isolation or a complete shell interceptor.

Cloud-doc comments are document-scoped: an `@bot` in a document comment uses that document's session and follows document permissions, not the IM allowlist.

One turn → one bridge-owned final reply. Agents must not post the final answer to the triggering chat themselves (`lark-cli im +messages-send` / `+messages-reply` / `send-card` to the current chat). Sending to other chats, or sending when the user explicitly asks for a lark-cli send, is allowed.

## Configuration and identity

Configuration lives under `profiles.<name>` in `$HOME/.lark-channel/config.json`; `LARK_CHANNEL_HOME` changes the data root. Common keys:

| Key | Meaning |
| --- | --- |
| `workspaces.default` | Profile's default working directory |
| `preferences.model` | Model selection passed to the CLI |
| `preferences.showToolCalls` | Whether to show tool activity |
| `preferences.backfill` | Offline catch-up switch and window (`enabled` / `dryRun` / lookback, etc.; `maxMentionsPerChat` caps both group @mentions and session-known DM human messages; omitted means defaults) |
| `mode` | `team`, or `personal` with an access list |
| `access.allowedUsers/allowedChats/admins` | User, group, and admin lists |
| `larkCli.identityPreset` | `user-default` allows using the authorized user identity |
| `automations.enabled` / `automations.agentTasks` | Enable group automations / allow agent tasks (both off by default) |
| `automations.timezone` | Time zone for automations (IANA name such as `Europe/London`); defaults to the host machine's local zone, or UTC if it cannot be detected |

Canonical permissions (legacy `sandbox` config is read and migrated; new config uses the canonical fields):

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

**lark-cli identity policy**: human conversations keep the existing identity convention; user-resource operations use `--as user` explicitly. For first full authorization, permission checks, and continuation steps, see the [setup guide](agent-setup.md#3-request-one-full-user-identity-authorization). Automations reuse the same profile's adapter and the environment below. They do not call the config-changing identity-policy, do not modify `larkCli.identityPreset`, and do not send authorization links to groups:

- `LARK_CHANNEL_HOME` / `LARK_CHANNEL_PROFILE`: the same data root and profile.
- `LARK_CHANNEL_CONFIG`: `<data-root>/profiles/<profile>/lark-cli-source/config.json`.
- `LARKSUITE_CLI_CONFIG_DIR`: `<data-root>/profiles/<profile>/lark-cli`. Human and automated runs share this directory; the bridge tool's connection environment must not override these identity variables.

The profile-local lark-cli directory is the current profile's lark-cli directory; the CLI manages credential storage. lark-cli owns token refresh, concurrency locks, and write-back checks; the bridge does not copy tokens, build its own credential store, or refresh on its own. The config directory must be owned and writable by the deploying user, and the credential store the CLI uses must be available to that user. Missing or expired authorization, platform rejection, or an explicit strict-mode restriction is handled as a task failure. Unattended runs never log in, change config, or borrow another profile's authorization. Resume tasks after a maintainer has handled dependencies, authorization, or account changes.

### Verifying the lark-cli dependency for automations

Before deploying, record the actual version and profile-binding capability with read-only commands: `lark-cli --version` and `lark-cli config bind --help` (should include `lark-channel`). Help text cannot prove locking and refresh write-back; check the corresponding release's implementation and controlled concurrency results. If profile binding, concurrent-refresh locking, or write-back checks are missing, diagnose "lark-cli dependency not ready: needs profile binding plus concurrent-refresh locking/write-back checks", stop the related operation, and have a maintainer prepare a suitable version. Do not work around it by changing the environment, logging in automatically, or copying tokens. The bridge does not substitute a guessed minimum version number for a capability check.

Evidence from the P03 code phase (2026-10-19):

- An isolated install of Linux x64 `@larksuite/cli@1.0.98` printed `lark-cli version 1.0.98`. Only version/help were run, confirming the `lark-channel` binding, strict-mode's read/write distinction, and that `auth status --verify` is a network check. No binding, login, or platform request was performed.
- In the matching release tag [v1.0.98 (ac81f505)](https://github.com/larksuite/cli/tree/ac81f5056ab88f37d581d25916f3dab85abfca76), [token_lock.go](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/internal/auth/token_lock.go) uses in-process and cross-process locks; [uat_client.go](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/internal/auth/uat_client.go) re-reads inside the lock, checks store writability, and compares the original credential generation before writing back. This is source evidence; it does not claim 1.0.98 is the minimum version.
- Automated regression starts the real adapter/subprocess through `startChannel` and uses a synthetic authorization principal and a controllable credential-store stand-in. It verifies human/automated concurrency on the shared directory, a single refresh, and unchanged config for later human sessions, covering bot/user and failure paths. The stand-in version is `0.0.0-controlled`; it does not represent the native CLI or real platform acceptance.
- **Operator-pending (P09)**: on the target deployment version/OS/credential store, verify the real CLI's concurrent refresh, actual Feishu operations with authorized bot/user, and actual selection by the seven model CLIs. This phase has no such results.

`LARK_CHANNEL_CLAUDE_BIN`, `LARK_CHANNEL_CODEX_BIN`, `LARK_CHANNEL_KIMI_BIN`, `LARK_CHANNEL_GROK_BIN`, `LARK_CHANNEL_CURSOR_BIN`, `LARK_CHANNEL_ANTIGRAVITY_BIN`, and `LARK_CHANNEL_DEVIN_BIN` resolve and save the executable path when a profile is created. Existing profiles use the saved `agent.binaryPath`; to change the executable, stop the profile first, then update the path. The data root and the coding CLI's login directory are different things. The Antigravity executable is `agy`.

### Devin ACP execution

Devin runs through `devin acp` over bidirectional stdio. Prompts, session handles, permission modes and model selection use the protocol; no print-mode ATIF export is needed. Old short Devin handles remain loadable. History replay is excluded from the current answer, text whitespace is preserved, and native tool events feed the existing message-send deduplication, automation guard and idle watchdog. The guard remains best effort, as with the other adapters.

Every new or loaded session receives the current run's permissions before its prompt. Without native sandbox, the default mapping is read-only → `ask`, workspace → `accept-edits`, full → `bypass`. Profile `agent.options.permissionMode` may narrow that mapping. Unexpected requests for human permission are rejected and reported as blocked execution; they do not silently broaden access or count as successful completion.

`agent.options.sandbox: true` enables Devin's native `--sandbox`, independently of generic access hints. Its modes are `plan` for read-only and `autonomous` for writable sandboxed work. Explicit `smart` or `accept-edits` preferences that cannot be retained in that native sandbox are rejected before starting a writable run. The sandbox follows Devin's own granted scopes and platform exceptions: local macOS smoke denied a write to our disposable home fixture outside the workspace, while a system-temp write was allowed. Do not treat it as an absolute denial of every path outside cwd. Existing OS prerequisites and CLI policy still apply.

Model aliases `opus` and `sonnet` select the first matching ordinary model advertised by Devin. `swe-2-max` selects the SWE-2 family and max thought level when exposed separately. Unavailable explicit models or configuration values fail visibly. These rules also apply when resuming; the adapter does not silently create a new conversation after a failed load.


## External bridge plugins

Bridge plugins are host-prepared content, separate from each CLI's native plugins. The bridge provides discovery and content/resource lookup; scripts run with the runtime's existing tools and access mode. It does not download, clone, install dependencies, host MCP/hooks/daemons, change CLI trust, or offer agent-facing install/update/uninstall/start/stop operations.

Create `<data-root>/plugins.json` beside the deployment's bridge configuration (`LARK_CHANNEL_HOME`, default `~/.lark-channel`). It is shared by all profiles using that root:

```json
{
  "schemaVersion": 1,
  "packages": [
    "/srv/larkent-plugins/engineering-v1",
    "/srv/larkent-plugins/command-tools-v1"
  ]
}
```

Each entry is an explicit absolute **package root**, not a parent directory to scan. Windows uses absolute Windows paths with JSON escaping. Prepare a local directory or a Git checkout at a fixed revision outside the product; only the selected directories are read. No configuration file means built-in automation only. Invalid installation configuration is reported as `invalid-installation-config`; the built-in package remains discoverable. Ordinary invalid packages are diagnosed separately without taking down chat or other packages.

### Supported manifest subset

Each package must have `.codex-plugin/plugin.json`. The tested compatibility subset is `name`, `version`, `description`, and `skills`; this does not promise compatibility with every Codex or native plugin feature. A Matt-like pure skill bundle can use an explicit array of nested skill directories. A command-dependent bundle declares its host requirements using the bridge-specific `larkent` metadata below. A raw `.claude-plugin` package needs a maintainer-prepared compatible manifest; native installation is independent. The reference shapes are the [Codex compatibility manifest](https://developers.openai.com/plugins/build/plugins) and [Matt's pinned skill directory list](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/.claude-plugin/plugin.json); automated fixtures contain synthetic content only.

```json
{
  "name": "command-tools",
  "version": "1.0.0",
  "description": "Read synthetic command reports",
  "skills": ["./skills/report", "./skills/guide"],
  "larkent": {
    "aliases": ["reports"],
    "resources": ["./references", "./scripts"],
    "skills": {
      "report": {"aliases": ["summarize-report"], "requires": {"commands": ["node"]}}
    }
  }
}
```

- Names and aliases are lowercase identifiers beginning with a letter, followed by letters, digits or hyphens. A skill's name is its directory basename; each directory contains `SKILL.md`. Skill frontmatter remains content, not business logic.
- `skills` is either a directory whose immediate child directories are skills, or a nonempty array of exact skill directories (including nested layouts). Each selected skill directory also declares its contained references, scripts and other resources. `larkent.resources` explicitly declares additional package-relative files/directories. Undeclared package files cannot be read through the catalog.
- Supply a nonempty, whitespace-free version identifier, or omit `version` and supply `larkent.revision` as a fixed 40-character lowercase Git SHA. The operator is responsible for preparing that exact checkout. Read results include the effective version and a content reference derived from the selected location, manifest and declared contents.
- `larkent.requires` applies to all skills; `larkent.skills.<directory-name>.requires` applies only to that skill. `commands` lists executable names on the bridge host's PATH, never command lines. This verifies presence/executable access, not credentials, permissions, command versions or network readiness. Record those separately on the deployment host. The bridge never runs a dependency probe or installer on a package's behalf.
- `requires.content` lists required content types. The supported types are `skill`, `resource`, `script` and `command`. Required unsupported types (for example `hooks` or `mcp`) make affected skills unavailable. Declared native `mcpServers`, `hooks`, `apps` and `agents` produce `unsupported-content` diagnostics and are not hosted; independent skills can remain available. A package with missing dependencies is partial/unavailable, not wholly ready merely because a skill file exists.

### Discovery, resources and diagnostics

Every IM run, including a resumed conversation, and every scheduled agent run receives short current package summaries and the common contract from its profile’s startup catalog snapshot. Skill bodies and the full skill index are read on demand. Use the existing run-bound client (`node <LARK_BRIDGE_TOOL_CLIENT> tool`) with structured JSON on stdin; shell-quote paths for the current runtime. Connection values stay in the child environment, never in prompts, task records or ordinary logs. `tool --schema` works without a run connection and describes the plugin request fields.

```json
{"version":1,"operation":"plugins.inspect","params":{"plugin":"command-tools"}}
{"version":1,"operation":"plugins.inspect","params":{"plugin":"command-tools","reference":"<reference returned by candidate>"}}
{"version":1,"operation":"plugins.read","params":{"skill":"command-tools:report"}}
{"version":1,"operation":"plugins.read","params":{"skill":"command-tools:report","reference":"<reference returned by candidate>"}}
{"version":1,"operation":"plugins.read","params":{"skill":"command-tools:report","resource":"scripts/report.mjs","reference":"<reference returned by read>"}}
```

`plugins.list` returns summaries and load diagnostics. Packages sharing an ID remain listed individually with version, root, reference and `plugin-conflict` diagnostics. `plugins.inspect` returns the skill directory and each skill's availability/diagnostics. `plugins.read` accepts a qualified `plugin:skill` identifier or a unique name/alias. Naming a unique plugin directly returns its directory. Ambiguous plugin/skill names return `plugin-ambiguous` / `skill-ambiguous` with candidates; duplicate IDs are never overwritten in scan order. Choose a candidate and pass its `reference` unchanged as `params.reference` together with its ID (`params.plugin` for inspect, `params.skill` for read). The reference selects the package before ambiguity checks, even when IDs and versions match. A canonical `plugin:skill` alone cannot distinguish packages sharing an ID; without a selector they remain ambiguous. References select content only: canonical automation business bindings still require a unique available automation package and are independent of external discovery aliases.

Content results include `content`, `source` (plugin, effective version, content reference, package-relative resource, checked absolute path and content type), and declared resource paths. Use the returned relative resource path for another read. Files under `scripts/` are identified as scripts; the bridge returns their location/content but does not execute them. The runtime's ordinary tool must execute a benign script and check its actual exit/output; a successful lookup is not execution success. Failure of that process remains a runtime tool failure.

`missing-root` (the configured package path does not exist, or a path component is not a directory), `invalid-root` (the path exists but is not a directory), `missing-manifest`, `invalid-manifest`, `invalid-metadata`, `invalid-path`, `missing-skills`, `missing-skill-content`, `plugin-conflict`, `skill-conflict`, `missing-command`, `unsupported-content` and `unsupported-required-content` identify distinct problems. `invalid-package` is the fallback for an unclassified package load failure. Installation diagnostics include the offending root, and capability diagnostics identify the missing command/type. Fix the selected package/configuration externally and restart. If built-in automation is unavailable, machine operations return `automation-plugin-unavailable` instead of pretending to execute them.

Paths must stay within the package and its declared content scopes. Absolute paths, traversal and symlink escapes are rejected; symlink real targets are checked during loading and again before returning content/script locations. These are deterministic content-addressing checks, not a sandbox. A process with the host account's shell still has that account's permissions. The bridge neither raises CLI trust nor isolates arbitrary shell execution.

### Version updates and resumed sessions

Prepare a **new version directory**; retain the previous directory while old runs may use it. Change the selected absolute directory in `plugins.json`, drain active runs and restart the affected profiles/deployment through the usual operations workflow. A profile loads its configuration/catalog once at startup; editing configuration has no effect on its active catalog. New and resumed runs after restart receive the new summary/version and contract. There is no file watcher or in-place hot replacement.

Retain `source.reference` when following a resource link. `stale-plugin-reference` means the reference no longer selects the requested package/skill in this catalog: rediscover/read the current skill, then follow its current resources. `package-changed` means a loaded manifest/content path or bytes changed/disappeared in place; lookup fails explicitly instead of combining the cached body with a new script. Restore the old directory or deploy a new directory and restart. Never overwrite a live package directory. As with ordinary shell tools, lookup cannot prevent a host writer from changing a file after lookup; immutable version directories and draining are operator requirements.

The automated catalog, real-client IM and subprocess checks cover synthetic pure skills and command/script bundles, shared profiles, restart/resume, dependencies, ambiguity and containment. Real model selection, the deployment's native CLI versions/access modes, paid model calls, and real Feishu bot/user permissions remain operator acceptance work; skipped opt-in smoke tests are not evidence of those checks.

### Seven-CLI invocation contract and operator evidence

`pnpm exec vitest run tests/process/seven-cli-bridge-contract.test.ts tests/process/bridge-tools.test.ts` runs without native CLI logins or opt-in flags. The seven-row suite starts the actual profile adapters through `startChannel`, using controlled runtime executables (`0.0.0-controlled`, no model). Each child invokes the shared client with JSON stdin and reads actual results before replying. The matrix includes external package scripts, discovery, schema/query, same-turn correction, create/replace/delete confirmation receipts, pause/resume, result queries after automatic execution, fresh credentials, forged-context rejection, completion and stop revocation. Runtime, package and working paths contain spaces and shell metacharacters. The existing CI runs this suite inside `pnpm test` on Ubuntu, macOS and Windows; inspect the exact commit's job logs for seven executed rows.

| Adapter | Control-process new/resumed IM | Scheduled runs / result continuation | Native CLI version/model and new/resume loops |
| --- | --- | --- | --- |
| Claude | Covered; workspace permission argv retained | Fresh fires; human continuation resumes fire session | Operator-pending |
| Codex | Covered; workspace sandbox and native config options retained | Fresh fires; human continuation resumes fire thread | Operator-pending |
| Kimi | Covered; existing access mapping retained | Fresh fires; human continuation resumes fire session | Operator-pending |
| Grok | Covered; existing access mapping retained | Fresh fires; human continuation resumes fire session | Operator-pending |
| Cursor | Covered; existing full-access mapping retained | Fresh fires; human continuation resumes fire session | Operator-pending |
| Antigravity | Covered; existing full-access mapping retained | Fresh fires; human continuation resumes fire conversation | Operator-pending |
| Devin | Covered via native ACP-shaped control peer; current permissions reapplied after load | Fresh fires; human continuation resumes fire session | macOS local new/resume, tools, sandbox and stop smoke passed (3000.11.92, swe-2-high); real Feishu acceptance pending |

These are adapter/control-process checks. A synthetic native-config sentinel staying unchanged does not establish native plugin loading, trust enforcement or a model tool loop. Scheduled fires intentionally start fresh; a human follow-up to their result is an IM run with current facts and a new credential, even when it resumes that session.

P09 operators should complete the following for **each row independently**, on the final accepted commit:

1. Follow [agent setup](agent-setup.md) with an existing dedicated test profile/group and installed, authorized CLI. Record OS, Node and bridge versions, native executable `--version`, selected model, access mode/trust and relevant existing native plugins. Keep profile secrets and raw private logs off the public repository. Do not raise permissions to make a check pass; record a blocked access mode explicitly.
2. Use the corresponding opt-in `tests/process/<kind>-real.smoke.test.ts` and its `*_REAL_SMOKE=1` switch for baseline native new/resume behavior (see Development checks). Those tests can spend quota and do not themselves exercise this complete bridge-tool contract.
3. In a fresh IM session, ask the agent to discover/read automation and a preinstalled benign script package, execute its declared script, query tasks/schema, and preview a fixed three-day 09:00 schedule. Ask for one preview with the end boundary omitted, then correction using the actual returned `missing-end-at` result while retaining 09:00. Observe client invocations and structured results in the native tool loop; do not paste successful results into the conversation. Have the agent create the task and report its operation ID and waiting-confirmation state. Confirm the real card, then query the operation from a resumed turn; it must report applied and the three exact occurrences.
4. In that resumed session, exercise pause/resume, replace and delete with their real confirmation boundaries; query each receipt. For an agent task, allow an actual scheduled fire, verify plugin/script access and bot/user operations within the profile's existing authorization, and verify management calls are unavailable during that automatic run. Reply to its delivered result and check that human continuation can query the actual execution/delivery state. Record new/resume separately, including same-turn error correction in both.
5. Stop an active test run and verify its former client connection fails; query any already-accepted operation from a later valid run. After deploying a new immutable plugin version through the normal operator restart procedure, resume the old session and verify the current summary/version, stale-reference rejection and unchanged native plugins/trust. Include literal Unicode, quotes, spaces and shell characters through JSON stdin on each target OS; keep stdout as one protocol result and diagnostics on stderr.

Publish a sanitized per-row evidence record with exact SHA, OS, native CLI/model versions, new/resume outcomes, invocation/result observations, card/task/receipt state, and failures or unavailable permissions. Missing native CLIs, authorization, paid probes, live Feishu checks and native plugin/trust evidence remain **unverified/operator-pending**; another adapter's result or skipped smoke test cannot fill a row.

## Self-heal

Sleep, a process restart, or a short WebSocket blip can drop live messages. The bridge catches them up on its own: it pulls recent group history plus session-known DMs with bot identity, runs each survivor through the normal intake path once, and adds one lateness hint to the prompt. Groups still need an @mention. Ordinary human DMs do not. A first-contact DM with no prior session is out of scope (the user can resend). `maxMentionsPerChat` caps newest-first enqueue per chat for both. Personal-mode DM allowlisting stays on the live intake path. There is no `/config` toggle for backfill. No external poller or host routine.

Watch the profile log for this sequence:

`link.sleep` or `link.recovered` → `backfill.trigger` → `backfill.done`

`/doctor` prints a `self-heal:` line with the ledger path, `lastLiveAt` age, and processed-id count.

Kill switch: set `preferences.backfill.enabled` to `false`. Scans stop; the live watermark still advances so a later re-enable has a fresh window. Dry-run: set `preferences.backfill.dryRun` to `true`. The scan runs and logs `backfill.would-enqueue` per survivor, then posts nothing.

Staged rollout is an operations choice, not product behavior: enable on one profile, watch one recovery cycle, then the others. Every profile runs the same code.

## Automations monitor hook

This section is the contract larkent-monitor follows. The monitor is a private Cloudflare Worker (`POST /v1/status` → scan → wake webhook → this always-on box). It is not in this repo. No GitHub Action. Other PCs are out of scope. At most one wake per fire key, and only after a miss (no pre-wake). The pinned board card is human-only.

### Status push v2

Set optional profile keys `automations.statusEndpoint` (origin, no path) and `automations.statusSecret`. Either missing disables push; automations still run locally. The secret is never written to logs.

`POST <statusEndpoint>/v1/status` with JSON body and headers `x-timestamp` (UTC millis) and `x-signature` = hex `HMAC-SHA256(secret, timestamp + "." + body)`. Monitor accepts when the timestamp is within ±5 minutes **and** `updatedAt` is strictly greater than the last value for that `botKey`.

```json
{"v":2,"botKey":"<opaque>","updatedAt":0,"items":[{"id":"<opaque>","nextFires":[0],"lastFireAt":0,"paused":false,"endAt":0}]}
```

| Field | Meaning |
| --- | --- |
| `v` | Always `2` |
| `botKey` | HMAC of the profile name under the shared secret, truncated. Not a Feishu id. Rotating the secret changes every key. |
| `updatedAt` | Monotonic UTC millis from the bridge. Used only for upsert; not for miss detection. |
| `items[].id` | HMAC of `profile:number` under the shared secret, truncated. Not the `/auto` number. |
| `items[].nextFires` | Future planned instants, UTC millis: those in the next 24 hours up to 24 entries, or the single next fire if it is later. Empty when paused or there is no further fire. |
| `items[].lastFireAt` | Last started planned instant UTC millis; `0` if none |
| `items[].paused` | Pause state |
| `items[].endAt` | End UTC millis; `0` if none |

The body is a full replace for that `botKey`. Times are UTC milliseconds. No Feishu IDs, chat names, bot names, task text, schedule rules, or creator. The on-disk source of truth is `<data-root>/profiles/<profile>/automations-status.json`.

### Miss rule and fire key

For each unpaused item, `t` is the earliest `nextFires` value with `t > lastFireAt`. Miss when `now > t + scanSlack` (`scanSlack` covers push delay, about 2 minutes). `updatedAt` is not part of this predicate. If every listed `nextFires` is `≤ lastFireAt` or is already past and uncovered, miss on the earliest uncovered instant (the window ran out without another push).

Larkent's own catch-up still uses `!paused && nextFireAt > 0 && now > nextFireAt && lastFireAt < nextFireAt`. `now == nextFireAt` is not a miss. Paused items are not missed.

Fire key: `<id>@<nextFireAt>`, for example `3@1792218600000` (local `/auto` id, not the opaque push id). Wake at most once per key. After a miss, Larkent catch-up (restart, link recovery, or this wake) runs the latest eligible instant at most once within 24 hours; older instants are marked missed (shown as 已错过) and are not sent.

### Local wake CLI

```sh
node bin/lark-channel-bridge.mjs wake 3@1792218600000 --profile my-agent
```

`--profile` defaults to the active profile. The command writes `<data-root>/profiles/<profile>/automations-wake/wake-<stamp>-<hex>.json`:

```json
{"v":1,"fireKey":"3@1792218600000"}
```

Writes are atomic (`0600`). Skip names that start with `.` (temp files from the atomic rename).

The profile is running when `ps` lists it or its own classic OS service is running. Then the CLI exits 0 with no output and does not restart anything. The running scheduler consumes the directory on startup (after its own catch-up) and on change (`fs.watch` on the directory, plus a 500 ms readdir fallback because replace-via-rename can miss a watch event on Windows). That fallback is local file IPC, not a recovery poller.

If nothing is running, the CLI starts the registered topology: `start --web-ui` when the supervisor service is installed and there is no per-profile service; otherwise `start --profile` (skipping the interactive lark-cli check). Startup catch-up applies. Do not use this path for first-run setup.

If the supervisor service is already running but this profile is not in `ps`, the CLI still writes the wake file and exits 0 without bouncing supervisor or installing a second classic daemon. The console token is random per process and is not a wake channel; start that profile in the console (or make it the auto-started active profile). The next profile start drains the file.

Already started fire keys: no chat message, no board patch, no report to anyone. Local log only: `auto.wake.already-started`. Repeating `wake` for the same key is safe.

Linux, macOS, and Windows share this file transport. There is no stable IPC to the UI server: its token is random per process and is not used here.

## Logs and stored data

- Profile structured logs: `<data-root>/profiles/<profile>/logs/bridge-YYYYMMDD.jsonl`.
- Supervisor structured logs: `<data-root>/logs/bridge-YYYYMMDD.jsonl`.
- Automations wake requests: `<data-root>/profiles/<profile>/automations-wake/`.
- Daemon stdout/stderr paths are shown by `status --profile <profile>` / `status --web-ui`. Foreground runs are registered and listed by `ps`.

Profiles use schema v3; sessions, workspaces, and the catalog use v2. Rolling back a version requires restoring a matching data backup at the same time; switching the Git version alone does not downgrade persisted data.

`profile export` exports configuration; `profile remove --purge --yes` deletes data; `profile export --include-secrets --yes` includes sensitive information. Check each command's `--help` for exact arguments and run them only on an explicitly named profile. Keep data directories, export files, OAuth material, and logs in a private environment.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Registration flow has no TTY | Use a terminal/PTY, or provide credentials interactively through the existing-app path |
| CLI not found or fails to start | Check the executable's version, login, and the profile's saved `binaryPath` |
| Missing permission reading docs/chat history | Check the current profile, `--as user`, app scope, user scope, and target resource visibility |
| User authorization link expired | Restart the device flow with the full scope in the same profile |
| Restart says the profile is in use | Check the actual process and run mode, then stop the original owner cleanly |

## Development checks

```sh
pnpm ci:local
pnpm test
pnpm typecheck
pnpm build
```

The full gate is `pnpm ci:local`; the other three are for targeted investigation. Enable real CLI smoke tests as needed:

```sh
GROK_REAL_SMOKE=1 pnpm exec vitest run tests/process/grok-real.smoke.test.ts
KIMI_REAL_SMOKE=1 pnpm exec vitest run tests/process/kimi-real.smoke.test.ts
CURSOR_REAL_SMOKE=1 pnpm exec vitest run tests/process/cursor-real.smoke.test.ts
ANTIGRAVITY_REAL_SMOKE=1 pnpm exec vitest run tests/process/antigravity-real.smoke.test.ts
DEVIN_REAL_SMOKE=1 pnpm exec vitest run tests/process/devin-real.smoke.test.ts
```

Test file paths are relative to the repo root. Real smoke tests call the logged-in CLI; they verify the adapter and do not replace acceptance of the main Feishu flow. The Antigravity real smoke test uses `claude-sonnet-4-6` to avoid Gemini returning `User location is not supported` on some networks; the profile default still follows `agy`'s settings and does not force that model.

The DEVIN opt-in smoke uses `swe-2-high` (`DEVIN_SMOKE_MODEL` may select another installed model) and requires the logged-in native CLI, local `lark-cli`, and this checkout's built bridge client. It checks new/resumed sessions, exact file formatting, synthetic loopback tool calls with same-turn correction, native sandbox denial and cancellation. It sends no real Feishu messages and changes no login state. The sandbox case creates and removes a disposable `.larkent-devin-sandbox-*` directory in the user's home to avoid the system-temp write exception.



### Automation operation recovery

Model-initiated automation operations use `lark-channel-bridge tool` with versioned JSON on stdin. Every new or resumed run receives the current short discovery contract and a fresh environment-bound client connection. Final reply text has no automation side effects. The bridge tool creates reminders and agent tasks through the existing draft, end-completion and human confirmation cards. `automation.schema` reports the available task types and operations. Agent creation requires `automations.agentTasks` and the validated current working directory; the task captures that directory and records its creator separately from the profile’s execution identity. Existing reminders and agent tasks support pause/resume immediately and replace/delete through human confirmation. Query the current target with `automation.list` and submit its `revision` with the target `id`; stale confirmations cannot mutate a changed or deleted target. Manual `/auto` commands and dashboard buttons keep their existing immediate semantics. Task mutations and their receipts commit atomically; task queries expose committed state. A model cannot confirm a task.

Retain the `operationId` returned by the client, including after timeouts or transport failures. Query `automation.operation.get` in a later legitimate run in the same profile/chat before retrying. IDs can be submitted for 24 hours; expired IDs are never fresh writes. Same-ID content changes conflict. Semantic retries durably bind each submitted ID to the original operation, which remains queryable after confirmation. Durable receipts remain in `automations.json` v2, with atomic reading/upgrading of v1 tasks, drafts and original confirmation cards. Upgrade the existing profile data in place; keep tasks, unfinished drafts, valid signed confirmation cards, dashboard bindings and callback nonce history. End-date completion still requires a separate human confirmation. Profile identity configuration and lark-cli credentials are retained. No store clearing, task recreation or compatibility switch is required. A staged result or old reply correction already in the outbox can still finish delivery and recall without starting a model operation. Follow the existing matching-data-backup rule for code rollback.

`waiting-confirmation` requires an actual card receipt. `applied` means the human-confirmed task was saved; it does not mean a future reminder has already fired or been delivered. Dispatch counts, successful execution counts, failed/interrupted counts, and delivered result counts are reported separately, with execution-history completeness. `executionState` and `lastExecution` report runtime evidence; `lastDelivery` and `deliveredCount` report outbox evidence, including failure notices. Runtime or CLI startup failure leaves creation applied; a delivered failure notice is not successful execution. An empty successful run produces the explicit empty-result message. Staged results recover without rerunning the business operation. A known rejected send reports not-applied. An unsent or still-prepared confirmation card, including while the long connection is down, remains pending (`unknown` / `card-not-sent`), not a terminal not-applied; the same operation is flushed after reconnect. An uncertain send remains unknown even after a restart or the submission deadline: recovery only binds a message found by its exact signed callback and bot sender. A missing history match is not proof of non-delivery. Do not resend or recreate an unknown operation under a new ID; preserve the original receipt for operator reconciliation. No live Feishu or model acceptance is established by the automated fixture tests.

Operation-query execution counters describe the linked task’s lifetime (`executionScope: task`), including fires before a pause/resume/delete request. For an existing/manual task without a reliable lifetime receipt, dispatch count is unknown (`dispatchedCount: null`), with a retained `dispatchedCountLowerBound`; execution history remains explicitly incomplete even if the retained journal happens to match that bound. Application evidence and task execution/delivery evidence remain separate. Each automatic run gets a fresh local tool connection, revoked on completion or stop; the manual creator’s credential is never reused. Scheduled runs can discover/read plugins and perform authorized business operations, while the server rejects recursive create/replace/delete/pause/resume regardless of shell access. A subsequent human follow-up is an IM run even when it resumes the automatic result’s session scope. A failed replacement persistence write leaves its original confirmation controls available for recovery after the store is repaired and reloaded.
