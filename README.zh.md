# lark-channel-bridge（Kimi Code 分支）

把飞书 / Lark 消息接到本地 **Kimi Code** CLI 的桥。用户私聊 bot 或在群里
`@` 它，桥就运行 `kimi -p` 并把 agent 的答复发回聊天。

本仓库是 `lark-channel-bridge` 的 fork（上游还支持 Claude Code / Codex
CLI，代码保留但不是重点）。**没有发布到 npm**，只能从源码安装。

本 README 面向自动化部署 agent（例如 Grok Bot 这类常驻 AI 队友）编写：
每一步都是可执行命令 + 可验证结果。英文完整版：[README.md](./README.md)。

## 心智模型

```
飞书用户消息 ──WS 长连接──> bridge（本仓库）
   │  scope = chatId（话题群为 chatId:threadId）
   ▼
拉起 `kimi -p "<prompt>" --output-format stream-json`（后续轮次带 `-S <sessionId>`）
   │  stdout JSONL → AgentEvent（system / tool_use / tool_result / final_text / done）
   ▼
飞书回复（默认 markdown；每轮只发一条干净的最终消息）
```

- **会话**：每个 scope 一个 Kimi session，持久化在
  `~/.lark-channel/profiles/<profile>/`；每批消息起新进程、用 `-S` 续接，
  上下文跨轮保留。
- **访问**：本 fork 默认 `mode: team`——能看到 bot 的人都能用；管理命令
  （`/invite`、`/config` 等）仍只有 owner/admin 可用。
- **身份**：bot 说话永远是 bot。读聊天记录、搜索、文档/表格等公司资产时，
  agent 用 `lark-cli --as user`（owner 完成一次 OAuth 设备授权后可用）。
  lark-cli 策略为 `strict-mode off` + `default-as bot`（本 fork 默认）。

## 前置条件

| 依赖 | 检查命令 | 预期 |
|---|---|---|
| Node.js ≥ 20.12 | `node --version` | `v20.12.0` 或更新 |
| pnpm（用 npx 即可） | `npx pnpm --version` | 任意 10.x |
| Kimi Code CLI（已登录） | `kimi -p "say OK" --output-format stream-json` | stdout 输出 JSONL，退出码 0 |
| lark-cli | `lark-cli --version` | 如 `1.0.x` |
| 飞书/Lark 应用凭证 | — | 在下方"注册应用"步骤获得 |

kimi 未登录时先 `kimi login`（设备码流程，需要浏览器）。

## 从源码安装

```bash
git clone <本仓库地址> && cd lark-channel-bridge   # 或解压 tarball
npx pnpm install        # prepare 脚本会顺带构建 dist/
npx pnpm build          # 改动源码后重跑
```

CLI 入口是 `bin/lark-channel-bridge.mjs`；下文命令都在仓库根目录以
`node bin/lark-channel-bridge.mjs <命令>` 执行（也可 `npx pnpm link --global`
获得全局 `lark-channel-bridge` 命令）。

## 注册飞书应用

两条路；**无人值守部署选 B**。两条路结束时桥都会以前台方式运行——只想
完成配置的话按 Ctrl-C 停掉即可。

**A. 扫码向导（需要有人用手机飞书扫一次）：**

```bash
node bin/lark-channel-bridge.mjs run --agent kimi
```

向导要求 TTY。非 TTY 环境用自带辅助脚本：打印一个普通 URL 让人在浏览器
打开确认，确认后把凭证写入 JSON：

```bash
node scripts/register-app.mjs /tmp/app.json   # 打印 QR_URL=...，确认后自动退出
# 然后拿 /tmp/app.json 里的值走路径 B；用完删除该文件
```

**B. 已有应用凭证（完全非交互）：**

```bash
node bin/lark-channel-bridge.mjs run --agent kimi \
  --app-id cli_xxx --app-secret <secret> --tenant feishu   # 国际版 Lark 用 --tenant lark
```

配置写入 `~/.lark-channel/config.json`（可用 `LARK_CHANNEL_HOME` 改根目录）。
密钥存进每个 profile 的加密 keystore，不在 JSON 里。

## 运行

先前台验证：

```bash
node bin/lark-channel-bridge.mjs run
# 预期末尾输出："✓ 已连接  bot: <名字> ... agent: Kimi Code (kimi)"，随后"正在监听消息"
```

再装成系统服务（崩溃自愈、开机自启）：

```bash
node bin/lark-channel-bridge.mjs start    # macOS 用 launchd，Linux 用 systemd --user
node bin/lark-channel-bridge.mjs ps       # 查看运行中的 bot
node bin/lark-channel-bridge.mjs status   # 服务状态
node bin/lark-channel-bridge.mjs restart  # 改配置后重启
node bin/lark-channel-bridge.mjs stop     # 停止服务
```

Linux 注意：服务是 **systemd 用户单元**（`Restart=always`、`RestartSec=5`、
`WantedBy=default.target`）。无人登录的服务器上要执行一次：

```bash
loginctl enable-linger "$USER"
```

否则用户退出登录后服务会被系统回收。

## 部署验收

1. 飞书里私聊 bot（或群里 `@bot`）：`用一句话介绍你自己`。
   预期：约 30 秒内收到一条 markdown 回复，不带工具调用过程（本 fork
   默认 profile 已关 `showToolCalls`）。
2. 完成下面的 OAuth 后问：`回顾一下这个群最近的聊天记录`。
   预期：它以 owner 的用户身份读取并总结。
3. 日志：`~/.lark-channel/profiles/kimi/logs/bridge-YYYYMMDD.jsonl`
   （JSONL；grep `"phase":"run"` / `"event":"completed"`）。

## 一次性 owner OAuth（解锁读历史 / 编辑公司资产）

带上 profile 的 lark-cli 环境变量执行（若改过 `LARK_CHANNEL_HOME` 请相应调整）：

```bash
export LARK_CHANNEL=1 LARK_CHANNEL_HOME=~/.lark-channel LARK_CHANNEL_PROFILE=kimi \
  LARK_CHANNEL_CONFIG=~/.lark-channel/profiles/kimi/lark-cli-source/config.json \
  LARKSUITE_CLI_CONFIG_DIR=~/.lark-channel/profiles/kimi/lark-cli

lark-cli auth login --no-wait --json --domain im,docs,drive,wiki,sheets,base,markdown,task,calendar
# 输出 verification_url（10 分钟有效）和 device_code——把 URL 给 owner 打开确认
lark-cli auth login --device-code "<device_code>"   # 阻塞直到 owner 确认
lark-cli config strict-mode off && lark-cli config default-as bot
lark-cli auth status --json   # 预期 identities.user.status == "ready"，defaultAs == "bot"
```

agent 遵守的身份规则（已写进它的系统提示）：聊天输出永远以 bot 身份发出；
`--as user` 只用于读历史 / 搜索 / 文档 / 表格等资产操作。

## 配置参考

`~/.lark-channel/config.json` → `profiles.<name>`：

| 键 | 本 fork 默认 | 含义 |
|---|---|---|
| `agentKind` | `kimi` | agent 适配器 |
| `mode` | `team` | `team` 全员可用；`personal` 走白名单 |
| `access.allowedUsers/allowedChats/admins` | `[]` | personal 模式下使用；admin 两种模式都有效 |
| `preferences.model` | 不设置 | 固定 Kimi 模型别名 → `kimi -m` |
| `preferences.showToolCalls` | `false` | 不显示工具调用过程消息 |
| `larkCli.identityPreset` | `user-default` | 用户身份可用（默认身份仍是 bot） |

聊天内命令：`/help` `/status` `/config` `/cd <path>` `/new` `/stop`
`/resume` `/invite user @x` `/remove user @x` `/invite admin @x`
`/remove admin @x` `/invite group` `/remove group` `/invite all group`。

环境变量：`LARK_CHANNEL_HOME`（配置根目录）、`LARK_CHANNEL_KIMI_BIN`
（覆盖 kimi 二进制路径）。

## 多 profile

每个 profile 是一套独立的 bot 绑定（应用 + agent + 工作目录），位于
`~/.lark-channel/profiles/<name>/`，每个都能用 `start --profile <name>`
跑成独立的服务。管理命令：

```bash
node bin/lark-channel-bridge.mjs profile list
node bin/lark-channel-bridge.mjs profile create <name> --agent kimi
node bin/lark-channel-bridge.mjs profile use <name>
node bin/lark-channel-bridge.mjs profile export <name>                          # 导出 JSON 到 stdout
node bin/lark-channel-bridge.mjs profile export <name> --include-secrets --yes  # 含应用密钥
node bin/lark-channel-bridge.mjs profile remove <name>                          # 归档
node bin/lark-channel-bridge.mjs profile remove <name> --purge --yes            # 永久删除
```

`workspaces.default` 是 profile 的默认工作目录；用户在聊天里用
`/cd <path>` 覆盖，用 `/ws` 管理常用目录别名。

## 权限

kimi 的 print 模式固定走 CLI 自带的 auto 权限策略，桥层的权限配置在这里
只是声明性的。标准键是：

```json
"permissions": { "defaultAccess": "full", "maxAccess": "full" }
```

旧版 `sandbox` 配置块仍被接受并自动迁移；新 profile 不要手写它。

## lark-cli 身份策略

每个 profile 有当前 profile 的 lark-cli 目录
（`~/.lark-channel/profiles/<name>/lark-cli`）。启动时桥会把 lark-cli
身份策略（`strict-mode off`、`default-as bot`）应用到该目录：agent 默认
以 bot 身份行动，需要用户身份时逐次加 `--as user`。

## 云文档评论

云文档评论按文档权限生效：在飞书文档的评论里 @ bot，它就在那条评论
串里回答；能否使用取决于文档本身的权限，与聊天白名单无关。

## Windows

Windows 下守护进程用计划任务（其他平台用 launchd/systemd）。agent
二进制在需要时会解析到对应的 `.cmd` 垫片。

## 故障排查

| 症状 | 诊断 | 处理 |
|---|---|---|
| 完全没回复 | 日志没有 `intake enter` | 查 `ps`/`status`；核对应用凭证与 WS 连通性 |
| run 完成但没有消息 | 日志止于 `progress-stream-skipped` | 本 fork 已修（final-answer-only 回复），更新代码 |
| `agent-binary-not-found` | 预检失败 | 安装/登录 kimi，或设置 `LARK_CHANNEL_KIMI_BIN` |
| 读群历史报 `230027` | bot 身份缺权限 | 预期行为；完成 OAuth 后 agent 会走 `--as user` |
| OAuth 链接过期 | 10 分钟有效期 | 重跑 `auth login --no-wait` 取新链接 |
| Linux 退出登录后服务没了 | `systemctl --user status` 不活跃 | `loginctl enable-linger "$USER"` |

## 开发

```bash
npx pnpm typecheck
npx pnpm test            # 单元 + 集成 + 进程 + 静态契约
KIMI_REAL_SMOKE=1 npx vitest run tests/process/kimi-real.smoke.test.ts  # 真 kimi 冒烟（可选）
```

结构：`src/agent/kimi/` 是适配层——`argv.ts` 拼 CLI 调用，`jsonl.ts` 把
Kimi 的 stream-json 翻成 `AgentEvent`，`adapter.ts` 管子进程。适配层之上
（channel、卡片、会话、访问控制、命令、守护进程、web 控制台）与 agent
无关。共享 bot/card 代码不允许 import agent 内部实现，由
`tests/static/contracts.test.ts` 强制保证。

## 许可证

MIT（继承自上游）。
