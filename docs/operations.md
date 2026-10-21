# Larkent operations

运行参考；首次安装与用户授权先读 [agent setup](agent-setup.md)。本文中的命令在当前源码 checkout 执行，`my-agent` 替换为实际 profile 名。自定义数据根时，每条 bridge 命令带相同的 `LARK_CHANNEL_HOME`。

## Profiles and services

每个 profile 对应一个飞书应用和一种 CLI。前台运行：

```sh
node bin/lark-channel-bridge.mjs run --profile my-agent
node bin/lark-channel-bridge.mjs profile list
node bin/lark-channel-bridge.mjs ps
```

用前台终端的 `Ctrl-C` 停止，等待正常退出，再切换到 per-profile service：

```sh
node bin/lark-channel-bridge.mjs start --profile my-agent
node bin/lark-channel-bridge.mjs status --profile my-agent
node bin/lark-channel-bridge.mjs restart --profile my-agent
node bin/lark-channel-bridge.mjs stop --profile my-agent
```

macOS 使用 launchd；Linux 使用 systemd user；Windows 使用 Task Scheduler 和 `.cmd` 包装。Linux 服务若需在用户退出登录后继续运行，需要配置相应用户的 linger。

## Supervisor console

```sh
node bin/lark-channel-bridge.mjs run --web-ui
```

supervisor 先启动 active profile，其余在控制台按需启动。常驻控制台使用 `start --web-ui`，停止或重启使用 `stop --web-ui` / `restart --web-ui`。`ui --print` 输出本地入口。切换模式前先停止原模式中的同一 profile。

## Chat commands

- 基本操作：`/help`、`/status`、`/config`、`/cd <path>`、`/new`、`/stop`、`/resume`。
- 访问管理：`/invite user`、`/remove user`、`/invite group`、`/remove group`、`/invite all group`、`/invite admin`。
- 自动任务（仅群聊，需 `automations.enabled`）：`/auto list`、`/auto pause <id>`、`/auto resume <id>`、`/auto delete <id>`、`/auto new <时间表> | <名称> | <任务>`（agent 任务用 `/auto new agent ...`）。也可以直接用自然语言请 agent 创建或管理，创建/替换/删除需在确认卡上人工确认。
- `/stop` 停止当前 scope 的任务，profile 保持在线；前台 Ctrl-C 停止整个 profile。

## Automations events

`automations.enabled` 打开后，bridge 通过现有长连接的 `onRawEvent` 处理 bot 被移出群和群解散。在飞书开放平台为该应用订阅这两个事件（与会议 `vc.bot.*` 一样走同一条连接，不要再开第二条）：

- `im.chat.member.bot.deleted_v1`
- `im.chat.disbanded_v1`

未订阅时，bridge 仍会在发送被拒为不在群内（`230002`）或群已解散（`232009`）时删除该群任务。

Agent 任务（`automations.agentTasks`）沿用当前 profile 已授权的 bot/user 身份；任务正文、适用 skill 和操作需要决定选择。`--as user` 等已有身份选择不会触发策略中断，历史建群、成员、通讯录、人事等业务类别限制已退出。平台权限、profile 的明确配置和最终回复归属仍适用。任务的 `createdBy` 保留创建者，不据此切换 OAuth 用户。

无人值守时，登录、登出、绑定/初始化/移除配置、设置 strict-mode/default-as/risk-control、tenant-access-token 写入/移除、keychain-downgrade 和 profile add/use/remove/rename 等认证/身份配置变更仍触发 `policy-guard`：中断、暂停任务、群内通知和脱敏审计（`auth-config`）。读取 `auth status`、`config show` 或无参数的 strict-mode/default-as 是状态查询。工具事件检查覆盖常见 argv、命令字符串、包装命令和工具名称，但事件可能在命令执行后才出现；agent 仍有完整 shell，这不是主机权限隔离或完整 shell 拦截器。

Cloud-doc comments are document-scoped. 云文档评论按文档权限生效：文档评论中的 `@bot` 使用该文档会话，不套用 IM 白名单。

One turn → one bridge-owned final reply. Agents must not post the final answer to the triggering chat themselves (`lark-cli im +messages-send` / `+messages-reply` / `send-card` to the current chat). Sending to other chats, or sending when the user explicitly asks for a lark-cli send, is allowed. 一轮对话只有一条由 bridge 发出的最终回复；agent 不要自己把最终答案发到触发会话。

## Configuration and identity

配置位于 `$HOME/.lark-channel/config.json` 的 `profiles.<name>` 下；`LARK_CHANNEL_HOME` 可改变数据根。常用项：

| 项 | 含义 |
| --- | --- |
| `workspaces.default` | profile 默认工作目录 |
| `preferences.model` | 传给对应 CLI 的模型选择 |
| `preferences.showToolCalls` | 是否展示工具过程 |
| `preferences.backfill` | 离线回补的开关与窗口（`enabled` / `dryRun` / lookback 等；`maxMentionsPerChat` 对群 @ 和 session-known p2p 人话都封顶；缺省即默认值） |
| `mode` | `team` 或带访问名单的 `personal` |
| `access.allowedUsers/allowedChats/admins` | 用户、群和管理员名单 |
| `larkCli.identityPreset` | `user-default` 允许使用已授权用户身份 |
| `automations.enabled` / `automations.agentTasks` | 开启群内自动任务 / 允许 agent 任务（默认均关闭） |
| `automations.timezone` | 自动任务使用的时区（IANA 名称，如 `Europe/London`），请设为你所在的时区 |

Canonical permissions（旧版 `sandbox` / legacy `sandbox` 配置可读取并迁移；新配置使用规范字段）：

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

**lark-cli identity policy / lark-cli 身份策略**：人工对话保持原身份约定，用户资源操作显式使用 `--as user`。首次完整授权、权限核验和续接步骤见 [setup 指南](agent-setup.md#3-主动请求一次完整用户身份授权)。自动任务复用同一 profile 的 adapter 和以下环境，不调用配置变更用的 identity-policy，不修改 `larkCli.identityPreset` 或向群发送授权链接：

- `LARK_CHANNEL_HOME` / `LARK_CHANNEL_PROFILE`：同一数据根和 profile。
- `LARK_CHANNEL_CONFIG`：`<data-root>/profiles/<profile>/lark-cli-source/config.json`。
- `LARKSUITE_CLI_CONFIG_DIR`：`<data-root>/profiles/<profile>/lark-cli`。人工与自动 run 共用此目录；不能以 bridge tool 的连接环境覆盖这些身份环境。

profile-local lark-cli directory 即当前 profile 的 lark-cli 目录；凭据存储由 CLI 管理。Token 刷新、并发锁和写回校验由 lark-cli 负责；bridge 不复制 token、不另建凭据存储、不自行刷新。配置目录须由同一部署用户持有并可写，CLI 自身使用的凭据存储须对该用户可用。授权缺失/过期、平台拒绝或显式 strict-mode 限制沿用任务失败处理；无人值守时不登录、不改配置、不借其他 profile 授权。维护者处理依赖、授权或账号变更后再恢复任务。

### 自动任务的 lark-cli 依赖核验

部署前用只读命令记录实际版本和 profile 绑定能力：`lark-cli --version`、`lark-cli config bind --help`（应包含 `lark-channel`）。锁与刷新写回不能由帮助文本证明；核对对应发布版的实现和受控并发结果。缺少 profile 绑定、并发刷新锁或写回校验时，诊断为“lark-cli 依赖未就绪：需要 profile 绑定及并发刷新加锁/写回校验能力”，停止相关操作并由维护者准备合适版本；不要通过改环境、自动登录或复制 token 绕过。bridge 不以猜测的最低版本号替代能力核验。

P03 代码阶段（2026-10-19）的证据：

- 隔离安装的 Linux x64 `@larksuite/cli@1.0.98` 实际输出 `lark-cli version 1.0.98`；只执行 version/help，确认 `lark-channel` 绑定、strict-mode 的读写区分及 `auth status --verify` 是网络验证；未执行绑定、登录或平台请求。
- 对应发布标签 [v1.0.98（ac81f505）](https://github.com/larksuite/cli/tree/ac81f5056ab88f37d581d25916f3dab85abfca76) 的 [token_lock.go](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/internal/auth/token_lock.go) 使用进程内和跨进程锁；[uat_client.go](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/internal/auth/uat_client.go) 在锁内重读、检查存储可写性并比较原代凭据后写回。这是源码证据，不宣称 1.0.98 为最低版本。
- 自动回归经 `startChannel` 启动真实 adapter/子进程，用合成授权主体和可控凭据存储替身验证人工/自动并发共享目录、一次刷新及后续人工会话配置不变，覆盖 bot/user 和失败路径。替身版本为 `0.0.0-controlled`，不代表原生 CLI 或真实平台验收。
- **Operator-pending（P09）**：在目标部署版本/OS/凭据存储上验证真实 CLI 的并发刷新，以及已授权 bot/user 的实际飞书操作和六种模型 CLI 的实际选择；本阶段没有这些结果。

`LARK_CHANNEL_CLAUDE_BIN`、`LARK_CHANNEL_CODEX_BIN`、`LARK_CHANNEL_KIMI_BIN`、`LARK_CHANNEL_GROK_BIN`、`LARK_CHANNEL_CURSOR_BIN`、`LARK_CHANNEL_ANTIGRAVITY_BIN` 用于创建 profile 时解析并保存程序路径。已有 profile 使用保存的 `agent.binaryPath`；更换程序前先停止 profile，再更新路径。数据根与 coding CLI 的登录目录是两回事。Antigravity 的程序名是 `agy`。

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

### Six-CLI invocation contract and operator evidence

`pnpm exec vitest run tests/process/six-cli-bridge-contract.test.ts tests/process/bridge-tools.test.ts` runs without native CLI logins or opt-in flags. The six-row suite starts the actual profile adapters through `startChannel`, using controlled runtime executables (`0.0.0-controlled`, no model). Each child invokes the shared client with JSON stdin and reads actual results before replying. The matrix includes external package scripts, discovery, schema/query, same-turn correction, create/replace/delete confirmation receipts, pause/resume, result queries after automatic execution, fresh credentials, forged-context rejection, completion and stop revocation. Runtime, package and working paths contain spaces and shell metacharacters. The existing CI runs this suite inside `pnpm test` on Ubuntu, macOS and Windows; inspect the exact commit's job logs for six executed rows.

| Adapter | Control-process new/resumed IM | Scheduled runs / result continuation | Native CLI version/model and new/resume loops |
| --- | --- | --- | --- |
| Claude | Covered; workspace permission argv retained | Fresh fires; human continuation resumes fire session | Operator-pending |
| Codex | Covered; workspace sandbox and native config options retained | Fresh fires; human continuation resumes fire thread | Operator-pending |
| Kimi | Covered; existing access mapping retained | Fresh fires; human continuation resumes fire session | Operator-pending |
| Grok | Covered; existing access mapping retained | Fresh fires; human continuation resumes fire session | Operator-pending |
| Cursor | Covered; existing full-access mapping retained | Fresh fires; human continuation resumes fire session | Operator-pending |
| Antigravity | Covered; existing full-access mapping retained | Fresh fires; human continuation resumes fire conversation | Operator-pending |

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

Fire key: `<id>@<nextFireAt>`, for example `3@1792218600000` (local `/auto` id, not the opaque push id). Wake at most once per key. After a miss, Larkent catch-up (restart, link recovery, or this wake) runs the latest eligible instant at most once within 24 hours; older instants are 已错过 and are not sent.

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

- profile 结构化日志：`<data-root>/profiles/<profile>/logs/bridge-YYYYMMDD.jsonl`。
- supervisor 结构化日志：`<data-root>/logs/bridge-YYYYMMDD.jsonl`。
- automations wake requests：`<data-root>/profiles/<profile>/automations-wake/`。
- daemon stdout/stderr 路径由 `status --profile <profile>` / `status --web-ui` 显示。前台运行登记用 `ps` 查看。

Profile 使用 schema v3，session、workspace 和 catalog 使用 v2。版本回退要同时恢复匹配的数据备份；仅切换 Git 版本不会降级持久化数据。

`profile export` 导出配置；`profile remove --purge --yes` 涉及删除；`profile export --include-secrets --yes` 包含敏感信息。具体参数先查对应 `--help`，只对已明确指定的 profile 执行。数据目录、导出文件、OAuth 材料和日志留在私有环境。

## Troubleshooting

| 现象 | 检查 |
| --- | --- |
| 注册流程没有 TTY | 使用终端/PTY，或在已有应用路径通过交互提供凭据 |
| CLI 找不到或启动失败 | 核对对应程序的版本、登录和 profile 保存的 binaryPath |
| 文档/聊天记录读取缺权限 | 核对当前 profile、`--as user`、app scope、用户 scope 和目标资源可见性 |
| 用户授权链接过期 | 在同一 profile 用完整范围重新发起 device flow |
| 重启提示 profile 已占用 | 先查实际进程与运行模式，正常停止原 owner |

## Development checks

```sh
pnpm ci:local
pnpm test
pnpm typecheck
pnpm build
```

完整门禁是 `pnpm ci:local`；后面三条用于定向排查。真实 CLI smoke 按需开启：

```sh
GROK_REAL_SMOKE=1 pnpm exec vitest run tests/process/grok-real.smoke.test.ts
KIMI_REAL_SMOKE=1 pnpm exec vitest run tests/process/kimi-real.smoke.test.ts
CURSOR_REAL_SMOKE=1 pnpm exec vitest run tests/process/cursor-real.smoke.test.ts
ANTIGRAVITY_REAL_SMOKE=1 pnpm exec vitest run tests/process/antigravity-real.smoke.test.ts
```

测试文件路径相对 repo 根。真实 smoke 会调用已登录的 CLI；它验证适配器，不替代飞书主流程验收。Antigravity 的真实 smoke 使用 `claude-sonnet-4-6`，避免部分网络下 Gemini 返回 `User location is not supported`；profile 默认仍跟随 `agy` 的 settings，不强制该模型。


### Automation operation recovery

Model-initiated automation operations use `lark-channel-bridge tool` with versioned JSON on stdin. Every new or resumed run receives the current short discovery contract and a fresh environment-bound client connection. Final reply text has no automation side effects. The bridge tool creates reminders and agent tasks through the existing draft, end-completion and human confirmation cards. `automation.schema` reports the available task types and operations. Agent creation requires `automations.agentTasks` and the validated current working directory; the task captures that directory and records its creator separately from the profile’s execution identity. Existing reminders and agent tasks support pause/resume immediately and replace/delete through human confirmation. Query the current target with `automation.list` and submit its `revision` with the target `id`; stale confirmations cannot mutate a changed or deleted target. Manual `/auto` commands and dashboard buttons keep their existing immediate semantics. Task mutations and their receipts commit atomically; task queries expose committed state. A model cannot confirm a task.

Retain the `operationId` returned by the client, including after timeouts or transport failures. Query `automation.operation.get` in a later legitimate run in the same profile/chat before retrying. IDs can be submitted for 24 hours; expired IDs are never fresh writes. Same-ID content changes conflict. Semantic retries durably bind each submitted ID to the original operation, which remains queryable after confirmation. Durable receipts remain in `automations.json` v2, with atomic reading/upgrading of v1 tasks, drafts and original confirmation cards. Upgrade the existing profile data in place; keep tasks, unfinished drafts, valid signed confirmation cards, dashboard bindings and callback nonce history. End-date completion still requires a separate human confirmation. Profile identity configuration and lark-cli credentials are retained. No store clearing, task recreation or compatibility switch is required. A staged result or old reply correction already in the outbox can still finish delivery and recall without starting a model operation. Follow the existing matching-data-backup rule for code rollback.

`waiting-confirmation` requires an actual card receipt. `applied` means the human-confirmed task was saved; it does not mean a future reminder has already fired or been delivered. Dispatch counts, successful execution counts, failed/interrupted counts, and delivered result counts are reported separately, with execution-history completeness. `executionState` and `lastExecution` report runtime evidence; `lastDelivery` and `deliveredCount` report outbox evidence, including failure notices. Runtime or CLI startup failure leaves creation applied; a delivered failure notice is not successful execution. An empty successful run produces the explicit empty-result message. Staged results recover without rerunning the business operation. A known rejected send reports not-applied. An unsent or still-prepared confirmation card, including while the long connection is down, remains pending (`unknown` / `card-not-sent`), not a terminal not-applied; the same operation is flushed after reconnect. An uncertain send remains unknown even after a restart or the submission deadline: recovery only binds a message found by its exact signed callback and bot sender. A missing history match is not proof of non-delivery. Do not resend or recreate an unknown operation under a new ID; preserve the original receipt for operator reconciliation. No live Feishu or model acceptance is established by the automated fixture tests.

Operation-query execution counters describe the linked task’s lifetime (`executionScope: task`), including fires before a pause/resume/delete request. For an existing/manual task without a reliable lifetime receipt, dispatch count is unknown (`dispatchedCount: null`), with a retained `dispatchedCountLowerBound`; execution history remains explicitly incomplete even if the retained journal happens to match that bound. Application evidence and task execution/delivery evidence remain separate. Each automatic run gets a fresh local tool connection, revoked on completion or stop; the manual creator’s credential is never reused. Scheduled runs can discover/read plugins and perform authorized business operations, while the server rejects recursive create/replace/delete/pause/resume regardless of shell access. A subsequent human follow-up is an IM run even when it resumes the automatic result’s session scope. A failed replacement persistence write leaves its original confirmation controls available for recovery after the store is repaired and reloaded.
