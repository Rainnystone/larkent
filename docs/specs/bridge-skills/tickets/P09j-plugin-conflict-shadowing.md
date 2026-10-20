# Task 9j — P09j 同名冲突包遮蔽合法包且无法消歧

**Status:** done · fixed in #52 by 14eb356, 5e266e3（2026-10-20） · bug · P3
**Delivers:** 同名插件包冲突时，用户/模型仍能通过明确的选择器（version 或 reference）选中目标包；冲突包不让合法包整体消失。
**Found in:** [P09](P09-real-feishu-acceptance.md) 场景 8，候选版本 `0b55865`（Kimi）
**Worker class:** judgment（选择器形态需与 D2/D3 一致）
**Blocked by:** None

## Bug

- **场景：** 测试包 `p09-pure` v1 与一个同名冲突包（`p09-pure` 9.9.9）同时配置。
- **期望：** 同名能力不互相覆盖，用户可以明确选中目标。
- **实际：** `plugins.list` 两个都不列，只给 `plugin-conflict` 诊断；读 `greeting` 返回 `skill-ambiguous`，两个候选的 canonical ID 都是 `p09-pure:greeting`（只靠 version 区分）。按 operations 文档“用 canonical package/skill 组合选择”无法消歧，合法包被后加的冲突包整体遮蔽。
- **严重度：** P3（有诊断，不影响其他包和聊天）。

## Evidence

- P09 证据目录 `read-kimi-4.json`。

## Root cause（`0b55865`）

- `src/plugins/catalog.ts:97-98`：同 id 的包全部标为 `plugin-conflict`。
- `src/plugins/catalog.ts:136-148` `resolveRead`：虽然接受 `options.reference`，但 `matches.length > 1` 时先返回 `skill-ambiguous`（候选 `id` 相同），reference 只在唯一命中后才比对；唯一命中且 `this.conflicted(plugin.id)` 时又退回 inspect。因此任何选择器都无法选中冲突中的某一包。
- `docs/operations.md:157` 承诺的“canonical 组合选择”在同 id 时无效。

## What to build

- `plugins.read` / `plugins.inspect` 先按已返回的 `reference`（或 `version`）过滤候选，再判断歧义与冲突，唯一命中时直接读取该包；歧义结果中的候选给出可直接回传的选择器。
- `plugins.list` 对冲突项列出各候选（带 version、root、reference 和冲突诊断），而不是全部隐藏。
- 未指定选择器时仍返回歧义，不按扫描顺序静默选择（保持“不覆盖”）。
- 更新 `docs/operations.md` 与 automation/插件 skill 中的选择说明。

## Acceptance criteria

- [ ] catalog 单测：两包同 id 时 list 列出两个候选并带 `plugin-conflict`；带 `reference` 的 read 返回对应包内容；不带选择器仍为 `skill-ambiguous`；过期 reference 返回 `stale-plugin-reference`。
- [ ] `pnpm ci:local` 通过。
- [ ] P09 场景 8 重跑：冲突配置下能通过歧义结果中的选择器读取 v1 的 greeting。

## Addendum（P09 第 3 轮补充证据，不是新 bug）

- Grok 续会话读 `greeting` 返回 `skill-ambiguous`，两个候选（同 canonical `p09-pure:greeting`，version 2.0.0 / 9.9.9）**各自带 reference**；但把候选里的 reference 回传仍无法选中其中一个。
- 原因同上：`src/plugins/catalog.ts:136-149` `resolveRead` 先判断 `matches.length > 1`，再检查 reference，所以歧义结果给出的 reference 本身不可用来消歧。
- 追加验收：
  - [ ] 用 `skill-ambiguous` 结果中某个候选原样回传的 reference 调用 `plugins.read`，返回该候选的内容。
