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

Cloud-doc comments are document-scoped. 云文档评论按文档权限生效：文档评论中的 `@bot` 使用该文档会话，不套用 IM 白名单。

One turn → one bridge-owned final reply. Agents must not post the final answer to the triggering chat themselves (`lark-cli im +messages-send` / `+messages-reply` / `send-card` to the current chat). Sending to other chats, or sending when the user explicitly asks for a lark-cli send, is allowed. 一轮对话只有一条由 bridge 发出的最终回复；agent 不要自己把最终答案发到触发会话。

## Configuration and identity

配置位于 `$HOME/.lark-channel/config.json` 的 `profiles.<name>` 下；`LARK_CHANNEL_HOME` 可改变数据根。常用项：

| 项 | 含义 |
| --- | --- |
| `workspaces.default` | profile 默认工作目录 |
| `preferences.model` | 传给对应 CLI 的模型选择 |
| `preferences.showToolCalls` | 是否展示工具过程 |
| `preferences.backfill` | 离线 @mention 回补的开关与窗口（`enabled` / `dryRun` / lookback 等；缺省即默认值） |
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

**lark-cli identity policy / lark-cli 身份策略**：发言保持 bot；读取用户资源显式使用 `--as user`。Token 保存在 profile-local lark-cli directory，即当前 profile 的 lark-cli 目录。首次完整授权、权限核验和续接步骤见 [setup 指南](agent-setup.md#3-主动请求一次完整用户身份授权)。

`LARK_CHANNEL_CLAUDE_BIN`、`LARK_CHANNEL_CODEX_BIN`、`LARK_CHANNEL_KIMI_BIN`、`LARK_CHANNEL_GROK_BIN`、`LARK_CHANNEL_CURSOR_BIN`、`LARK_CHANNEL_ANTIGRAVITY_BIN` 用于创建 profile 时解析并保存程序路径。已有 profile 使用保存的 `agent.binaryPath`；更换程序前先停止 profile，再更新路径。数据根与 coding CLI 的登录目录是两回事。Antigravity 的程序名是 `agy`。

## Self-heal

Sleep, a process restart, or a short WebSocket blip can drop live @mentions. The bridge catches them up on its own: it pulls recent group history with bot identity, runs each missed @ through the normal intake path once, and adds one lateness hint to the prompt. No external poller or host routine.

Watch the profile log for this sequence:

`keepalive.wake-up` or `ws.reconnected` → `backfill.trigger` → `backfill.done`

`/doctor` prints a `self-heal:` line with the ledger path, `lastLiveAt` age, and processed-id count.

Kill switch: set `preferences.backfill.enabled` to `false`. Scans stop; the live watermark still advances so a later re-enable has a fresh window. Dry-run: set `preferences.backfill.dryRun` to `true`. The scan runs and logs `backfill.would-enqueue` per survivor, then posts nothing.

Staged rollout is an operations choice, not product behavior: enable on one profile, watch one recovery cycle, then the others. Every profile runs the same code.

## Logs and stored data

- profile 结构化日志：`<data-root>/profiles/<profile>/logs/bridge-YYYYMMDD.jsonl`。
- supervisor 结构化日志：`<data-root>/logs/bridge-YYYYMMDD.jsonl`。
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
