# Task 9h — P09h 从未触发的任务 lastStatus 显示为 ok

**Status:** ready-for-agent · bug · P3
**Delivers:** 新建、从未触发的任务在 `automation.list` 与看板中显示“尚未运行”，不再显示为上次运行成功。
**Found in:** [P09](P09-real-feishu-acceptance.md) 列出本群自动化，候选版本 `0b55865`（Antigravity、Kimi 回复中出现）
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** 刚确认创建的一次性提醒，尚未触发；用户“列出本群自动化”。
- **期望：** 不显示为“上次运行成功”；D7 要求区分“已应用”与“执行完成”。
- **实际：** `automation.list` 返回 `lastStatus:"ok"`，模型回复中写出“lastStatus: ok”。
- **严重度：** P3（误导模型与用户，不影响执行）。

## Evidence

- P09 证据目录中 Antigravity、Kimi 列表回复的回读；store 中新任务 `lastFireAt: 0` 而 `lastStatus: "ok"`。

## Root cause（`0b55865`）

- `src/automations/store.ts:422` 创建任务时 `lastStatus: 'ok'` 作为初始值；`AutomationLastStatus`（`:23`）没有“未运行”取值。
- `src/automations/tools.ts:78` 原样输出该字段。

## What to build

- 增加 `never`（或等价）状态作为新任务初始值；首次触发后按现有逻辑更新为 running/ok/failed/missed。
- 存储升级：已有 `lastFireAt === 0 && lastStatus === 'ok'` 的任务读取时视为 `never`（不改动其他字段）。
- `automation.list`、看板与 schema 说明同步；skill 中给出“尚未运行”的用户表述。

## Acceptance criteria

- [ ] 单测：新建任务 `lastStatus` 为 `never`；触发一次成功后为 `ok`；失败为 `failed`。
- [ ] 单测：旧存储（`lastFireAt: 0`, `lastStatus: 'ok'`）加载后 list 返回 `never`。
- [ ] 看板/列表渲染测试更新；`pnpm ci:local` 通过。
