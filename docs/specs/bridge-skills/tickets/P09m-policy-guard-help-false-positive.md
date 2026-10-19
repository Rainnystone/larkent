# Task 9m — P09m 只读 `lark-cli auth logout --help` 被误判为 auth-config，任务被暂停

**Status:** ready-for-agent · bug · P3
**Delivers:** 自动 run 策略守卫不把 `--help`/`-h` 等只读帮助调用判为认证/身份配置变更；守卫命中时 `auth-config` 代码对 agent 可见，而不仅在日志中。
**Found in:** [P09](P09-real-feishu-acceptance.md) F4 补测，候选版本 `0b55865`（Grok Build）
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** 已确认的 agent 自动化任务内容为 `lark-cli auth logout --help`（只显示帮助，不会登出），到点触发。
- **期望：** 只有真正修改认证/身份配置的命令才触发 `auth-config`；只读 `--help` 正常完成。命中时规格 F4 要求“返回 `auth-config`”。
- **实际：** run 约 27 秒后被中断，任务被暂停、`lastStatus=failed`，群里发“自动化任务中断：策略拦截（认证/身份配置变更）。任务已暂停”。凭据文件未改变（F4 的拒绝/凭据不变部分成立）。`auth-config` 码只出现在 jsonl（`phase:auto event:policy-guard reason:auth-config`），返回给 agent 的工具结果里没有。
- **严重度：** P3（误报而非绕过；守卫文件头已声明为 best-effort 纵深防御，但误报会暂停无害任务）。

## Evidence

- 测试 profile jsonl 中该次 fire 的 `policy-guard` 事件；群内中断通知卡的回读 JSON；凭据配置文件 mtime 前后一致的记录。

## Root cause（`0b55865`）

- `src/automations/policy-guard.ts:93-103` `inspectLarkArgs` 只收集 positional，丢弃所有 flag；`mutatesIdentityConfiguration`（:106）对 `auth login/logout`、`profile add/...`、`config set/...` 只看 positional，没有 `--help`/`-h`/`help` 子命令的只读豁免。
- `src/automations/agent-run.ts:121-146、332-345` 命中后只把中文标签写进失败通知并暂停任务；稳定代码 `auth-config` 未进入 agent 可见的工具结果/中断原因。

## What to build

- 守卫在 lark-cli 参数中出现 `--help`、`-h`（或 `help` 作为子命令前缀）时视为只读、不命中；保持其他命令判定不变，不扩大放行面（例如 `--help` 出现在 `--` 之后的数据位置不豁免）。
- 守卫命中时，让 agent 收到的工具结果/中断信息包含稳定代码 `auth-config`（与中文标签并存），并与 jsonl 一致。

## Acceptance criteria

- [ ] policy-guard 单测：`auth logout --help`、`auth login -h`、`profile add --help`、`config set --help` 不命中；`auth logout`、`config set k v` 仍命中 `auth-config`。
- [ ] agent-run 测试：命中时 agent 可见结果含 `auth-config`；`--help` 任务正常完成，不暂停。
- [ ] `pnpm ci:local` 通过。
