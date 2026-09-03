# lark-channel-bridge（给 Grok Bot 用）

把 CLI coding agent 接到飞书/Lark bot 后面。一台机器（VPS，或 Grok Bot 云电脑）跑一个 supervisor；supervisor 托管任意数量的 **profile**；每个 profile 是一个飞书 bot，背后一个 **agent**。Grok Bot 是部署目标（SpaceXAI 常驻队友，自带一台云电脑）。它不是 agent。Grok Build 是五个 agent 之一，没有特殊地位。五个对等体是 `claude`、`codex`、`kimi`、`grok`、`cursor`。没有默认 agent。

本 README 是 **Grok Bot** 的执行手册。每一步都是命令 + 可核对结果。需要人的步骤标 **HUMAN**。
英文：[README.md](./README.md)。

没有发 npm。从源码安装。

## 选 agent

| Agent | `--agent` | 二进制 | 无头调用 | 续会话 | 机器必须能访问 |
|---|---|---|---|---|---|
| **Claude Code** | `claude` | `claude` | `claude -p --output-format stream-json` | `--resume` | Anthropic |
| **Codex CLI** | `codex` | `codex` | `codex exec --json` | `resume` | OpenAI |
| **Kimi Code** | `kimi` | `kimi` | `kimi -p --output-format stream-json` | `-S` | Moonshot |
| **Grok Build** | `grok` | `grok` | `grok -p --output-format streaming-json --always-approve` | `-r`（不要用 `-s`） | `auth.x.ai` / grok 代理（**必须在墙外**） |
| **Cursor CLI** | `cursor` | `cursor-agent`（回退 `agent`） | `agent -p --output-format stream-json --force --sandbox disabled --approve-mcps --trust` | `--resume` | Cursor API（已登录 CLI 或 `CURSOR_API_KEY`） |

一个 profile 不要混 agent。另建 profile。

把下文 `<AGENT>` 换成 `claude`、`codex`、`kimi`、`grok` 或 `cursor`。profile 名跟随 `--agent` 种类。没有默认 agent。

## 心智模型

```
飞书用户消息 ──WS 长连接──> 本进程
   │  scope = chatId（话题群 chatId:threadId）
   ▼
拉起本机 CLI（claude / codex / kimi / grok / cursor-agent -p …）→ stdout JSONL → AgentEvent
   ▼
一条飞书 markdown（默认不展示 tool 过程）
```

- **会话**：catalog 在 `~/.lark-channel/profiles/<profile>/`；Grok 原生会话在
  `~/.grok/sessions/`。每批消息一个 CLI 进程。
- **发言 vs 读取**：聊天输出永远是 **bot**。读群历史、文档、表格等走
  `lark-cli --as user`（owner 完成一次 OAuth 之后）。Token 在
  **当前 profile 的 lark-cli 目录**，不在某个挂着的 agent 进程里。重启桥
  不需要登录进程还活着。
- **首次 init 默认**（`run`/`start` 写盘，不要手改除非被要求）：
  `mode: team`、`showToolCalls: false`、`larkCli.identityPreset: user-default`、
  **lark-cli 身份策略** `strict-mode off` + `default-as bot`。

## 主机约束

- Node.js ≥ 20.12，可写 `$HOME`，出站 HTTPS。
- **Grok Build**：机器必须打到 xAI。墙内主机即使用户在别的设备完成了
  device-code 也会失败。不要把 grok profile 放在境内 VPS。
- **Kimi Code**：不需要 xAI；仍要能连 `open.feishu.cn`。
- **Cursor CLI**：需要 Cursor API（已登录 CLI 或 `CURSOR_API_KEY`）。不需要 xAI。
- **不要**给 bot 单独设 `GROK_HOME` / 隔离 `~/.grok`，继承已登录的
  `auth.json`。Kimi 同理（`~/.kimi-code`）。Cursor 继承已登录 CLI /
  `CURSOR_API_KEY`。隔离家目录等于再登一次。
- 想走 SuperGrok 额度就 **不要**设 `XAI_API_KEY`。

## 前置（安装前先核对）

| 依赖 | 检查 | 通过 |
|---|---|---|
| Node ≥ 20.12 | `node --version` | `v20.12.0` 或更新 |
| pnpm | `npx pnpm --version` | 任意 10.x |
| lark-cli | `lark-cli --version` | 如 `1.0.x` |
| Grok（若 `--agent grok`） | `grok --version` 且 `test -f ~/.grok/auth.json` | 二进制 + 登录文件 |
| Kimi（若 `--agent kimi`） | `kimi -p "say OK" --output-format stream-json` | JSONL，退出码 0 |
| Cursor（若 `--agent cursor`） | `cursor-agent --version` 或 `agent --version` | Cursor CLI 版本横幅 |
| TTY | `[ -t 0 ] && [ -t 1 ] && echo tty` | `tty` — 扫码向导需要 |

**HUMAN — 本机 agent 登录（每台机器一次）：**

- Grok：`grok login --device-auth`（URL + 短码，owner 在任意设备确认）。
- Kimi：`kimi login`。
- Cursor：`agent login`（或设 `CURSOR_API_KEY`）。

Grok CLI：`curl -fsSL https://x.ai/cli/install.sh | bash`。
Cursor CLI：`curl https://cursor.com/install -fsS | bash`（二进制名是 `agent`；把 `~/.local/bin` 加进 PATH）。如果二进制是 `agent` 而不是 `cursor-agent`，设 `LARK_CHANNEL_CURSOR_BIN=agent`。
缺 lark-cli：`npm install -g @larksuite/cli`。

## 安装

```bash
git clone https://github.com/Rainnystone/larkent-for-grokbot.git
cd larkent-for-grokbot
npx pnpm install
npx pnpm build
```

入口：仓库根目录 `node bin/lark-channel-bridge.mjs <命令>`。

## 注册飞书应用

**HUMAN。** 无 TTY（Grok Bot 云壳常见）走 B，不要跑扫码向导。

**A. 扫码向导（必须 TTY）：**

```bash
node bin/lark-channel-bridge.mjs run --agent <AGENT>
```

打印二维码和 URL。owner 用飞书 App 扫。等到 stdout 出现 `✓ 应用创建成功`
再出现 `正在监听消息`。

stdin 不是 TTY 就不要走 A，改 B。

**B. 已有应用凭证（可脚本化）：**

```bash
node bin/lark-channel-bridge.mjs run --agent <AGENT> \
  --app-id cli_xxx --app-secret <secret> --tenant feishu
```

国际版 Lark 用 `--tenant lark`。向 owner 要 id/secret，不要编。只想写配置的话，
看到 `正在监听消息` 后 Ctrl-C。

配置：`~/.lark-channel/config.json`（`LARK_CHANNEL_HOME` 改根目录）。
密钥进每个 profile 的 keystore，不进 JSON。

## Owner OAuth（CLI，不要塞进 coding-agent 那一轮）

读群历史、改租户文档之前必须做。Token 写在 **当前 profile 的 lark-cli 目录**。
这是首次 init 的一步，不是某个 grok/kimi 进程一直挂着。

**HUMAN** 打开 `verification_url`（10 分钟有效）。**前台**跑；不要把
device-code 等待丢到后台。

```bash
export LARK_CHANNEL=1 LARK_CHANNEL_HOME=~/.lark-channel LARK_CHANNEL_PROFILE=<AGENT> \
  LARK_CHANNEL_CONFIG=~/.lark-channel/profiles/<AGENT>/lark-cli-source/config.json \
  LARKSUITE_CLI_CONFIG_DIR=~/.lark-channel/profiles/<AGENT>/lark-cli

lark-cli auth login --no-wait --json --domain im,docs,drive,wiki,sheets,base,markdown,task,calendar
# 把 verification_url 和 device_code 给 owner
lark-cli auth login --device-code "<device_code>"
lark-cli config strict-mode off && lark-cli config default-as bot
lark-cli auth status --json
# 通过：identities.user.status == "ready"，identities.bot.status == "ready"，defaultAs == "bot"
```

这就是 **lark-cli 身份策略**：说话是 bot；`--as user` 只用于读/资产。
授权链接不要发到群里（谁先点谁绑 token）。

## 运行

先前台：

```bash
node bin/lark-channel-bridge.mjs run --agent <AGENT>
# 通过："✓ 已连接  bot: <名字> ... agent: Grok Build (grok)" / "Kimi Code (kimi)" / "Cursor CLI (cursor)"
# 然后 "正在监听消息"
```

再装成系统 **per-profile service**（macOS launchd，Linux systemd `--user`）。
Windows 上是 `.cmd` 包装，交给 schtasks。

```bash
node bin/lark-channel-bridge.mjs start
node bin/lark-channel-bridge.mjs ps
node bin/lark-channel-bridge.mjs status
node bin/lark-channel-bridge.mjs restart
node bin/lark-channel-bridge.mjs stop
```

无人登录的 Linux：`loginctl enable-linger "$USER"`，否则用户退出后服务被收。

## 验收

1. 飞书私聊（或群 `@bot`）：`用一句话介绍你自己`。
   通过：约 30 秒一条 markdown，没有 tool 行（`showToolCalls: false`）。
2. Owner OAuth 之后：`回顾一下这个群最近的聊天记录`。
   通过：用 owner 用户身份读；聊天里说话的仍是 bot。
3. 日志：`~/.lark-channel/profiles/<AGENT>/logs/bridge-YYYYMMDD.jsonl`
   （`"phase":"run"` / `"event":"completed"`）。

## 配置参考

`~/.lark-channel/config.json` → `profiles.<name>`：

| 键 | 默认 | 含义 |
|---|---|---|
| `agentKind` | `--agent` 种类。没有默认 agent。 | 适配器 |
| `mode` | `team` | `team` 能看到就能用；`personal` 走白名单 |
| `access.allowedUsers/allowedChats/admins` | `[]` | personal 用；admin 两种模式都有效 |
| `workspaces.default` | profile 工作区 | `/cd` 默认目录 |
| `preferences.model` | 不设置 | `grok -m` / `kimi -m` / `cursor --model` |
| `preferences.showToolCalls` | `false` | 不展示工具过程 |
| `larkCli.identityPreset` | `user-default` | 允许用户身份；默认身份仍是 bot |

规范权限（旧版 `sandbox` 读入时会规范化掉，不要再写新的 sandbox 键）：

```json
"permissions": {
  "defaultAccess": "full",
  "maxAccess": "full"
}
```

聊天：`/help` `/status` `/config` `/cd <path>` `/new` `/stop` `/resume`
`/invite user` `/remove user` `/invite group` `/remove group`
`/invite all group` `/invite admin`。

Profile CLI：`profile export`、`profile remove --purge --yes`、
`profile export --include-secrets --yes`。

环境变量：`LARK_CHANNEL_HOME`、`LARK_CHANNEL_GROK_BIN`、`LARK_CHANNEL_KIMI_BIN`、`LARK_CHANNEL_CURSOR_BIN`。

云文档评论按文档权限生效：在飞书文档评论里 `@bot` 走该文档会话，不走 IM 白名单。

## 故障排查

| 症状 | 诊断 | 处理 |
|---|---|---|
| 扫码向导报非交互 | 没有 TTY | `--app-id` / `--app-secret` |
| `agent-binary-not-found` | CLI 不在 PATH | 安装/登录；或设 `LARK_CHANNEL_GROK_BIN` / `LARK_CHANNEL_KIMI_BIN` / `LARK_CHANNEL_CURSOR_BIN` |
| 服务器上 Grok 认证失败 | 主机到不了 xAI | 把进程放到墙外 |
| Grok 续会话变空白 | 误用了 `-s` | adapter 只用 `-r` |
| 读群历史 `230027` | bot 没这个权限 | 预期；OAuth 后走 `--as user` |
| OAuth 链接过期 | 10 分钟 | 重跑 `auth login --no-wait` |
| Linux 退出登录服务没了 | systemd 用户单元 | `loginctl enable-linger "$USER"` |
| 飞书里刷 tool 行 | `showToolCalls` 为 true | `/config` 关掉；本 fork 默认已是 false |

## 开发

```bash
npx pnpm typecheck
npx pnpm test
npx pnpm build
GROK_REAL_SMOKE=1 npx vitest run tests/process/grok-real.smoke.test.ts
KIMI_REAL_SMOKE=1 npx vitest run tests/process/kimi-real.smoke.test.ts
CURSOR_REAL_SMOKE=1 npx vitest run tests/process/cursor-real.smoke.test.ts
```

适配层：`src/agent/claude/`、`src/agent/codex/`、`src/agent/kimi/`、`src/agent/grok/`、`src/agent/cursor/`。通道、卡片、
会话、守护进程、web 控制台与 agent 无关。共享 bot/card 代码不许 import
adapter 内部（`tests/static/contracts.test.ts`）。

## 许可证

MIT（继承自上游）。
