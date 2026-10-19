# Task 9c — P09c 发卡结果未知时，回读对账永远绑不上卡片

**Status:** ready-for-agent · bug · P2
**Delivers:** 确认卡发送结果未知（`sending`）后，bridge 能用飞书回读找到已送达的卡并绑定草稿；该卡点击可正常确认，operation 不再永久停在 unknown。
**Found in:** [P09](P09-real-feishu-acceptance.md) F7，候选版本 `0b55865`（F7 结果：fail）
**Worker class:** investigative（先确认飞书回读能返回什么，再定对账证据）
**Blocked by:** None

## Bug

- **场景（F7）：** 对一张已发送、未点击的替换确认卡，分别不带和带 `card_msg_content_type=user_card_content` 调用消息回读；同时核对 bridge 自身的对账路径。
- **期望：** 带参数时正文为 schema 2.0，能取到与原卡一致的签名回调 token；bridge 回读对账以带参结果为准，`sending` 状态的已送达卡能绑定到草稿。
- **实际：**
  - 不带参数（用户身份与 bot 身份都试过）：返回降级内容“请升级至最新版本客户端”，无按钮。
  - 带参数：返回 schema 2.0 正文，有「是」「否」按钮，但按钮只有 `element_id/tag/text/type` 四个字段，没有 `behaviors/value`，`auto_token` 出现 0 次（bot 身份相同）。bridge 存的原卡里有 2 个 `auto_token`。F7 的期望不成立。
  - bridge 对账路径根本没带该参数，且依赖 `auto_token` 比对，所以对 `sending` 卡永远匹配不上。
- **后果：** 一旦在发卡后、拿到回执前崩溃或超时，已送达的卡点下去是“此确认已失效”（`findDraftByCardMessageId` 找不到），operation 一直停在 unknown。D7/A11 的“结果未知后可恢复关联”路径实际不可用。不会重复发卡（“Absence proves nothing”）。
- **严重度：** P2（只在发卡结果未知时触发，但恢复路径整体失效）。

## Evidence

- P09 证据目录 `F7-with-param.json`、`F7-without-param.json`（同一条卡片消息的两次回读）。
- 受影响 profile 的 `automations.json` 中该草稿 `delivery.card` 含 2 个 `auto_token`，回读结果含 0 个。

## Root cause（`0b55865`）

- `src/automations/draft-delivery.ts:31-60` `reconcileDraftCard`：用 `feishuReadbackListParams` 列消息，再以 `callbackTokens(body)`（`:62-65`，递归收集 `auto_token`）与原卡 token 比对，只有精确命中才 `bindDraftCard`。
- `src/bot/feishu-delivery.ts:10-31` `feishuReadbackListParams` 不带 `card_msg_content_type`，回读拿到的是降级内容。
- 即使补上参数，飞书回读也不回传 `behaviors/value`，`auto_token` 不可见；“签名回调 token 是唯一正证据”这一对账假设与平台行为不符。

## What to build

- 回读请求带 `card_msg_content_type=user_card_content`（会话与话题容器都要）。
- 改用回读中确实保留的字段作为正证据：例如在发卡时把草稿专属、不可猜的短标记写入按钮 `element_id`（或其他经实测会原样回传的字段），对账时按该标记 + 发送者为本 bot + 创建时间不早于草稿来匹配。具体字段由实测决定，不可依赖 `behaviors/value`。
- 维持现有安全性质：多于一条匹配不绑定；未找到不等于未送达；不重复发卡。
- 若实测证明没有任何字段可回传，改为显式的人工恢复路径（例如该草稿给出明确的“结果未知”状态和重新发卡指引），并同步修订 P09 F7 的期望与对账说明。

## Acceptance criteria

- [ ] 单测：`feishuReadbackListParams` 输出含 `card_msg_content_type: 'user_card_content'`（chat 与 thread 两种容器）。
- [ ] 单测：用 F7 带参回读的实际结构（按钮仅含 element_id/tag/text/type）作为夹具，`reconcileDraftCard` 能为 `sending` 草稿绑定唯一匹配；两条匹配时不绑定；无匹配时状态不变。
- [ ] T1 业务链：模拟发卡后回执丢失（草稿停在 `sending`）→ 重启 → 对账 → 点击该卡得到正常确认结果而非“此确认已失效”，operation 由 unknown 进入实际状态；全过程只有一张卡。
- [ ] `pnpm ci:local` 通过。
- [ ] P09 重跑 F7（已更新期望）：带参回读能取到所选正证据字段，并与原卡一致。

## Non-goals

- 改变确认卡的签名回调机制本身；只改对账证据。
