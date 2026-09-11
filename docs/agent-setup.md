# Agent setup：首次接入飞书

供执行部署或接入任务的 agent 使用，适用于 Claude Code、Codex CLI、Kimi Code、Grok Build、Cursor CLI、Antigravity CLI。每个 profile 的首次 setup 包含三项：**本机 coding CLI 登录、飞书应用注册/常规授权、owner 的完整用户身份 OAuth**。负责 setup 的 agent 必须主动请用户完成第三项，再验证 wiki/文档与跨群聊天记录读取；不能在 bot 上线后就交付“setup 完成”。

用户身份授权保存在当前 profile 的 lark-cli 目录。正常重启复用有效授权；新增 profile、授权过期/撤销或实际缺少权限时再补授权。它不是机器全局 lark-cli 登录，也不是 coding CLI 的模型账号登录。

## 1. 核对环境与安装

1. 用 `git rev-parse --show-toplevel`、`git branch --show-current`、`git status --short` 核对用户指定的源码版本和 worktree。
2. 按 [中文 README 的环境要求](../README.zh.md#环境要求)（[English](../README.md#requirements)）核对目标 CLI、登录、网络、Node 和 pnpm。版本要求以 `package.json` 为准；从已有源码接续时直接使用当前 checkout。Antigravity CLI 的程序名是 `agy`（`agy --version`），不要用 `antigravity` 或 Gemini CLI；Cursor 的 `agent` 必须核实是 Cursor CLI。
3. 安装依赖 `pnpm install --frozen-lockfile`，执行 `pnpm build`，再检查 `node bin/lark-channel-bridge.mjs --help`。后续运行这个 checkout 的本地入口。

**完成条件：**依赖与构建成功，目标 CLI 已登录且能执行；记录实际 CLI 版本、源码 branch/SHA 和代码目录。

## 2. 注册并启动目标 profile

按 [快速开始](../README.zh.md#快速开始)（[English](../README.md#quick-start)）完成扫码或已有应用配置。自定义 profile 使用 `profile create <name> --agent <kind> --workspace <path>`；参数先查本地 `profile create --help`。明确记录本次实际使用的数据根和 profile 名，profile 名可能与 agent kind 不同。

先用 `LARK_CHANNEL_HOME=<实际数据根> node bin/lark-channel-bridge.mjs run --profile <实际profile名>` 前台启动，等 profile preflight、应用绑定和连接完成。需要 TTY 的扫码流程使用真实终端或 agent 工具的 PTY。setup agent 在另一个终端完成下一步 OAuth，让用户私下确认授权。

**完成条件：**连接提示的 bot、profile、agent 与目标一致；该 profile 的 `lark-cli/` 和 `lark-cli-source/config.json` 已由 bridge 初始化。此时继续用户身份授权。

## 3. 主动请求一次完整用户身份授权

向用户说明：“应用注册已完成。首次 setup 还需要你为这个 bot 完成一次完整的用户身份授权，以读取你有权限访问的 wiki、文档和其他群的聊天记录。授权后发言仍然使用 bot 身份。”

在 setup agent 的终端中，将下面两项设成**刚才启动的 profile**。自定义测试数据根不能套用默认目录。辅助函数让每条 lark-cli 命令使用同一个 profile；不要把 token 绑定到机器全局配置。

```sh
LARKENT_DATA_ROOT="$HOME/.lark-channel"
LARKENT_PROFILE='<实际profile名>'

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

已有完整、有效且属于目标 owner 的用户授权时，核对实际 scope 后直接复用。否则发起本次完整授权：

```sh
larkent_lark auth login --domain all --no-wait --json
```

`--domain all` 请求当前 lark-cli 支持的全部业务域用户权限。`--recommend` 只请求推荐权限；仅 IM、仅 wiki 或其它部分 scope 不能作为本项目的完整首次授权。应用后台开通权限与 owner 授权都必须满足；若某项需管理员批准或不可授予，记录缺失项并请用户完成实际需要的后台操作，不把缩小授权范围写成完整成功。完整授权也不扩大 owner 原有的资源可见范围。

按以下顺序完成 device flow：

1. 从本次返回中取得 `verification_url` 和 `device_code`。将原始 URL 与二维码展示给正确的 owner，使用本地私密对话或 bot 私聊；授权链接不发到群里，device code 由 setup agent 私下保存。
2. 用 `larkent_lark auth qrcode <verification_url> --output <相对PNG路径>` 生成二维码，在私有目录执行，避免把授权材料写进源码。确认用户能看到链接后，让用户完成授权。
3. 若 harness 只在本轮结束时显示回复，先交还控制权；收到用户完成授权的回复后，再由 setup agent 执行下面的续接命令。不要在链接尚不可见时阻塞等待，也不要把等待进程放到随本轮结束被回收的后台。

```sh
larkent_lark auth login --device-code '<本次返回的device_code>'
larkent_lark config strict-mode off
larkent_lark config default-as bot
larkent_lark auth status --json --verify
```

以上命令按顺序执行，失败时保留具体原因。链接过期时，用原来的 `--domain all --no-wait --json` 重新发起，不复用过期 code。面向用户只交代授权与验证结果，内部配置命令由 setup agent 执行。

**完成条件：**确认目标 owner、`identities.user.status == "ready"`、用户 token 的在线验证结果及实际授予 scope；同时 bot 身份可用、`defaultAs == "bot"`。只生成链接、只完成应用扫码，或仅显示 user ready 而未核对授权范围，都未完成本步骤。

## 4. 验证身份与真实访问

所有读取都在刚才的 profile 环境中执行。具体业务命令由相应 skill 或本机 `--help` 选择；用户资源读取明确加 `--as user`。

- 飞书消息往返：用户在私聊或目标群 `@bot`，收到目标 CLI 的实际回复；发言、卡片和回复保持 bot 身份。
- Wiki/文档：读取用户指定且本人能访问的一篇实际 wiki 页面或文档，核对返回的内容；不能仅用空列表或 bot 自己的资源证明成功。
- 跨群聊天记录：在用户指定、owner 有权访问的另一个群读取一段已知记录，确认结果来自该群，并使用用户身份。用户 token 不意味着可以读取任意群。
- 继续对话、停止、恢复和重启：按本次接入范围验证，确认重启后仍可使用该 profile 的用户授权，无需依赖之前的登录进程。

缺少可用的验证页面或群时，请用户给出最少的测试目标；权限错误先区分 app scope、用户 scope、token 状态和资源可见性。保留实际错误及缺失条件，修复后重试原读取。

**完成条件：**记录 profile、CLI 版本、bot 往返、完整用户授权及两类实际读取的结果。token、secret、device code 和授权二维码留在私有环境；交付只提供脱敏证据。未验证的能力明确标记，不能仅凭注册成功或自动化测试通过宣称全部 setup 完成。

## 按需继续

- 常驻服务、supervisor、停止与日志：[运行指南](operations.md)。
- 接入问题需改代码：在用户指定的 branch/worktree 留下回归与修复，执行 repo 的 `pnpm ci:local`；记录实际命令、退出码和真实场景复验结果。
