# Task 9i — P09i 补全结束日期卡缺少短于一个月的选项

**Status:** ready-for-agent · bug · P3
**Delivers:** 补全结束时间卡提供短于一个月的预设，常见“一周/两周”无需改用自然语言。
**Found in:** [P09](P09-real-feishu-acceptance.md) 场景 7，候选版本 `0b55865`（[P09a](P09a-recurring-count-copy.md) Non-goals 中记为另行处理）
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** 创建无结束时间的周期提醒，bridge 发“补全结束日期”卡。
- **期望：** 可补全任意结束时间，常用短期限可一键选择。
- **实际：** 预设只有“一个月 / 三个月 / 今年年底 / 一年”，最短一个月；更短必须用自然语言再说一次。
- **严重度：** P3（有自然语言替代路径）。

## Evidence

- P09 证据目录 `scenario7-summary.md`。

## Root cause（`0b55865`）

- `src/automations/end-card.ts:4-9` `END_CARD_PRESETS` 固定四项，最短 `auto.end.1m`；`EndCardTokens`（`:11-18`）与回调动作同样只有这些项。

## What to build

- 新增“一周”“两周”预设（`auto.end.1w`、`auto.end.2w`），结束边界按现有规则计算（包含开始、不包含结束，时区感知）。
- 回调签名、动作授权和确认卡次数文案沿用现有路径。

## Acceptance criteria

- [ ] end-card 单测：卡片含 6 个预设，顺序由短到长。
- [ ] 动作单测：选择“一周”后 endAt = startAt 所在时区 +7 天，确认卡次数与排期一致（与 P09a 的精确次数一致）。
- [ ] `pnpm ci:local` 通过。
