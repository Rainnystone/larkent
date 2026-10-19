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

The bridge tool creates reminders through the existing draft, end-completion and human confirmation cards. `automation.schema` reports the available operations; agent-task creation remains unavailable until its own delivery slice. Existing reminders and agent tasks support pause/resume immediately and replace/delete through human confirmation. Query the current target with `automation.list` and submit its `revision` with the target `id`; stale confirmations cannot mutate a changed or deleted target. Manual `/auto` commands and dashboard buttons keep their existing immediate semantics. Task mutations and their receipts commit atomically; task queries expose committed state. A model cannot confirm a task.

Retain the `operationId` returned by the client, including after timeouts or transport failures. Query `automation.operation.get` in a later legitimate run in the same profile/chat before retrying. IDs can be submitted for 24 hours; expired IDs are never fresh writes. Same-ID content changes conflict. Semantic retries durably bind each submitted ID to the original operation, which remains queryable after confirmation. Durable receipts remain in `automations.json` v2, with atomic reading/upgrading of v1 tasks, drafts and original confirmation cards. Follow the existing matching-data-backup rule for code rollback.

`waiting-confirmation` requires an actual card receipt. `applied` means the human-confirmed task was saved; it does not mean a future reminder has already fired or been delivered. Dispatch counts and observed journal delivery counts are reported separately, with execution-history completeness. A known rejected send reports not-applied. An uncertain send remains unknown even after a restart or the submission deadline: recovery only binds a message found by its exact signed callback and bot sender. A missing history match is not proof of non-delivery. Do not resend or recreate an unknown operation under a new ID; preserve the original receipt for operator reconciliation. No live Feishu or model acceptance is established by the automated fixture tests.

Operation-query execution counters describe the linked task’s lifetime (`executionScope: task`), including fires before a pause/resume/delete request. For an existing/manual task without a reliable lifetime receipt, dispatch count is unknown (`dispatchedCount: null`), with a retained `dispatchedCountLowerBound`; execution history remains explicitly incomplete even if the retained journal happens to match that bound. Application evidence and task execution/delivery evidence remain separate. A failed replacement persistence write leaves its original confirmation controls available for recovery after the store is repaired and reloaded.
