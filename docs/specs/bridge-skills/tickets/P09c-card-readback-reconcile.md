# Task 9c — P09c 发卡结果未知时，回读对账永远绑不上卡片

**Status:** ready-for-agent · bug · P2
**Delivers:** 确认卡发送结果未知（`sending`）后，bridge 能用飞书回读找到已送达的卡并绑定草稿；该卡点击可正常确认，operation 不再永久停在 unknown。
**Found in:** [P09](P09-real-feishu-acceptance.md) F7，候选版本 `0b55865`（F7 结果：fail）
**Worker class:** implementation（飞书行为已经实测确认，下文足够实现，不需要飞书访问权限）
**Size:** medium（改卡片构造 + 对账匹配 + 回读参数 + 夹具；不改回调签名机制）
**Blocked by:** None

## Bug

- 草稿卡发出后、拿到回执前崩溃或超时，草稿停在 `delivery.state = 'sending'`。
- `reconcileDraftCard` 列消息时不带 `card_msg_content_type`，拿到的是降级内容；就算带上，回读内容里也没有 `auto_token`，所以永远匹配不上。
- 后果：已送达的卡点下去提示“此确认已失效”（`findDraftByCardMessageId` 找不到），operation 一直停在 unknown。不会重复发卡（“Absence proves nothing”）。D7/A11 的恢复路径实际不可用。

## 已确认的飞书 API 行为（2026-10-20 实测，test bot 身份 + 官方文档）

实测用的是 schema 2.0 卡，两种发法都试了：内联 card JSON，以及 bridge 实际用的卡片实体（先 `POST /cardkit/v1/cards`，再按 `{"type":"card","data":{"card_id":…}}` 发送）。

### 1. 单条回读 `GET /im/v1/messages/:id`

| `card_msg_content_type` | `body.content` |
|---|---|
| 不传 | 降级的旧版内容：`{"title":…,"elements":[[{"tag":"img",…},{"tag":"text","text":"请升级至最新版本客户端，以查看内容"}]]}`，没有按钮，也没有任何自定义字段 |
| `user_card_content` | 发送时的卡片 JSON（schema 2.0），但**会去掉交互配置**：按钮只剩 `element_id / tag / text / type` 四个字段，`behaviors`、`value`（包括其中的 `auto_token` 和任何自定义键）**全部丢失**。`header`、`config.summary`、markdown 的 `content` 原样保留。**自定义的 `element_id` 原样保留**；没有指定 `element_id` 的组件会被分配 `_3`、`_7` 这类自动 ID |
| `raw_card_content`（文档未列出） | `{"json_card":"<内部渲染格式>","json_attachment":…,"card_schema":2}`；自定义 `element_id` 以 `id` 的形式出现，文本保留。属于内部格式，**不要依赖** |

- 两种发法的回读里都**不出现 `card_id`**，也没有模板变量或 `auto_token`。
- 用户身份与 bot 身份的返回结果一致。

净化后的 `user_card_content` 形状（夹具用）：

```json
{"schema":"2.0","config":{"enable_forward_interaction":false,"streaming_mode":false,"summary":{"content":"…"}},
 "header":{"title":{"tag":"plain_text","content":"确认自动化"}},
 "body":{"elements":[
   {"tag":"markdown","element_id":"_10","content":"**任务类型：** 提醒 …"},
   {"tag":"hr","element_id":"_9"},
   {"tag":"column_set","element_id":"_2","columns":[{"tag":"column","element_id":"_6","elements":[
     {"tag":"button","element_id":"<自定义 element_id 原样回传>","text":{"tag":"plain_text","content":"是"},"type":"primary"}]}]}]}}
```

### 2. 能在回读后保留下来的标识

- **按钮或任一组件的 `element_id`**：实测原样保留（单条回读和列表回读都保留）。飞书的约束是：以字母开头，只能用字母、数字、下划线，最长 20 字符，同一张卡内唯一。
- markdown 文本里写的标记也会保留，但会被用户看到，不推荐。
- `behaviors[].value` 或 callback value 里放的标记：**不会保留**。
- 消息 `uuid`：回读里不返回。

### 3. 列表回读 `GET /im/v1/messages?container_id_type=chat&container_id=…`

- 带 `card_msg_content_type=user_card_content` 时，每条卡片消息的 `body.content` 与单条回读带参的结果相同，自定义 `element_id` 可见（内联卡和卡片实体卡都已实测）。不带参时，列表里同样是降级内容，标记不可见。
- 所以 message id 未知时，可以用列表回读按标记找到卡，限制与单条回读相同：没有 `behaviors/value/auto_token`。
- 列表接口支持 `card_msg_content_type`（实测返回 200 且生效）。thread 容器这次**没有**实测，实现时按同样传参处理，用单测覆盖参数。

### 4. 发送幂等（`POST /im/v1/messages` 的 `uuid`）

- 官方文档：同一 `uuid` 在 1 小时内最多成功发送一条消息，最长 50 字符。
- **内联 card JSON**：用同一 `uuid` 重发，返回 `code 0`，并且**返回原消息的 `message_id` 和 `create_time`**，没有出现第二条消息。真正的幂等，回执可恢复。
- **卡片实体（`card_id`，bridge 现在的发法）**：用同一 `uuid` 和同一 `card_id` 重发，**失败**：`code 230099`，`ext=ErrCode: 200780; ErrMsg: card binding biz count over limit`。也就是卡片实体只能绑定一条消息，绑定检查先于 uuid 去重，所以**拿不回原 message_id**。这个错误只能说明“该 card_id 已经被绑定过”，不能告诉你绑在哪条消息上。
- bridge 已经在发送时传 `uuid: deliveryId`（`draft-delivery.ts` 的 `sendAutomationDraftCard`），但对卡片实体发法来说，这只能防止重复，不能恢复回执。

## Root cause（`0b55865`）

1. `src/bot/feishu-delivery.ts` 的 `feishuReadbackListParams` 没有传 `card_msg_content_type`，回读拿到的是降级内容。
2. `src/automations/draft-delivery.ts` 的 `reconcileDraftCard` 只把 `auto_token` 当作正证据（`callbackTokens`），而飞书回读在任何参数下都会去掉 `behaviors/value`，所以这个证据永远不存在。
3. 卡片实体发法下，`uuid` 重试不能恢复回执（见 §4）。

## Fix design（推荐）

按优先级：

**A. 嵌入标记 + 带参回读匹配（主方案，必须做）**
- 构造确认卡时（`src/automations/confirm-card.ts` 的 `buttonRow`/`callbackButton`），给“是”按钮设置确定性的 `element_id`，例如 `'lbd' + deliveryId.slice(0, 17)`（20 字符，字母开头，十六进制）。`deliveryId` 已在 `sendAutomationDraftCard` 里由 `sha256(operationId:kind)` 得到，不可猜测，而且同一份草稿每次都相同。“否”按钮可以用另一个前缀，或者干脆不设。
  - 注意：`sendAutomationDraftCard` 先算出 `deliveryId`，再持久化 `card`；标记必须在 `createCard` 之前写进卡里，所以要让卡片构造方拿到 `deliveryId`，或者由 `sendAutomationDraftCard` 在发卡前注入 `element_id`，并把注入后的卡存进 `delivery.card`。
  - 结束日期补全卡（`kind = 'end'`）也走同一路径，同样要注入标记。
- `feishuReadbackListParams` 增加 `card_msg_content_type: 'user_card_content'`（chat 与 thread 两种容器都加）。这个函数也被回复重投路径使用（`feishu-delivery.ts` 约 180 行）；只影响卡片消息的返回格式，需要确认那条路径的卡片匹配逻辑没有依赖降级格式。
- `reconcileDraftCard`：把 `callbackTokens` 替换为“递归收集 `element_id`”，正证据是：卡里含有本草稿的标记 `element_id`，同时满足 `sender.sender_type === 'app'`、`sender.id === botAppId`、`msg_type === 'interactive'`、`create_time >= draft.createdAt`。
- 保持现有安全性质：多于一条匹配不绑定；未找到不等于未送达，状态保持 `sending`，不重复发卡；分页上限不变。
- 旧草稿（升级前创建、卡里没有标记）：找不到标记就保持原状，不要回退到 `auto_token` 比对（永远不会命中）。

**B. 发送幂等（可选，不能替代 A）**
- 只有改成内联 card JSON 发送，`uuid` 重试才能返回原 `message_id`。但 bridge 依赖 `card_id` 做后续卡片更新，改发法影响面大，**本票不做**。
- 低成本增强（可选）：用同一 `card_id` 和 `uuid` 重试时如果收到 `230099` 且 `ext` 含 `200780`，就把它当作“已绑定、很可能已送达”，不要标记成 `rejected`。此时仍然靠 A 来找 message id。注意 `classify()` 现在可能把 230099 归为 `rejected`，要确认它不会把 `sending` 草稿错误地转成 `rejected`。

## Acceptance criteria

- [ ] 单测：`feishuReadbackListParams` 输出含 `card_msg_content_type: 'user_card_content'`（chat 与 thread 两种容器都要）。
- [ ] 单测：确认卡（confirm 与 end 两种）的“是”按钮 `element_id` 由 `deliveryId` 确定性地导出，符合 `^[A-Za-z][A-Za-z0-9_]{0,19}$`，卡内唯一；`delivery.card` 存的是注入标记后的卡。
- [ ] 单测 `reconcileDraftCard`（夹具见下）：
  - 唯一匹配 → `bindDraftCard(draftId, messageId, cardId, …)` 被调用一次；
  - 两条匹配 → 不绑定；
  - 无匹配 / 只有降级内容 / 只有其他草稿标记 / 发送者不是本 bot / `create_time` 早于草稿 → 状态不变；
  - 匹配跨页（第 2 页命中、`has_more` 结束）→ 绑定。
- [ ] 不再出现依赖 `auto_token` 出现在回读里的代码路径（`callbackTokens` 不再用于对账）。
- [ ] T1 业务链：模拟发卡后回执丢失（草稿停在 `sending`）→ 重启 → 对账 → 点击该卡得到正常确认结果，而不是“此确认已失效”；operation 从 unknown 进入实际状态；全过程只有一张卡。
- [ ] `pnpm ci:local` 通过。
- [ ] P09 重跑 F7，期望改为：带 `user_card_content` 回读，按钮 `element_id` 等于本草稿的标记；不再期望能读到 `auto_token`。

## Test approach

所有夹具都是合成数据，不使用任何真实 ID。对 `channel.rawClient.im.v1.message.list` 做 mock，返回：

```json
{"data":{"has_more":false,"page_token":"","items":[
  {"message_id":"om_test_1","msg_type":"interactive","create_time":"<draft.createdAt + 500>",
   "sender":{"id":"cli_test_bot","id_type":"app_id","sender_type":"app"},
   "body":{"content":"<JSON.stringify(上文 user_card_content 形状，按钮 element_id = 标记)>"}}]}}
```

需要的变体：
1. `match-one`：一条带本草稿标记。
2. `match-two`：两条都带本草稿标记（`om_test_1`、`om_test_2`）。
3. `degraded`：`body.content` 为降级形状 `{"title":"确认自动化","elements":[[{"tag":"img","image_key":"img_test"},{"tag":"text","text":"请升级至最新版本客户端，以查看内容"}]]}`（模拟没带参数）。
4. `other-marker`：标记属于另一个 deliveryId。
5. `wrong-sender`：`sender.sender_type: "user"`，或 `sender.id` 不是本 bot。
6. `too-early`：`create_time < draft.createdAt`。
7. `paged`：第 1 页 `has_more: true, page_token: "p2"`、没有匹配；第 2 页 `match-one`。
- 同时断言 `list` 收到的 params 含 `card_msg_content_type: 'user_card_content'`。
- 可选（方案 B）：mock `channel.send` 抛出 `code 230099`、`msg` 含 `ErrCode: 200780`，断言草稿**不会**被转成 `rejected`。

## Evidence

原始响应保存在仓库外的 P09 证据目录（`P09c-*.json`、`F7-*.json`），仓库中不保存。

## Non-goals

- 改变确认卡的签名回调机制（`auto_token` 仍放在 `behaviors.value` 中，用于点击校验）。
- 把卡片实体发法改为内联 JSON 发法。
