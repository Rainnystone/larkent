# A13 — 自动化卡片改为 CardKit schema 2.0，创建失败要可见

Status: ready-for-agent
Severity: **blocker**（A11 发现，确认卡/结束时间卡/看板在真实飞书里一张都发不出来）
Blocked by: —（独立于 A12；与 A14/A15 可并行）
Track: 推到现有 code 分支 `feat/automations-v2`（PR #49），不开新 PR
Spec: [../../automations.md](../../automations.md) §3（确认卡、结束时间卡）、§7（看板 + 状态块 v1）

## 现象（真实触发，A11 @ a27e564，Bot Arena，时间 Asia/Shanghai）
- 03:35:41、03:38:11、03:38:39 三次自然语言创建：agent 回复「已提交本群…提醒」后，日志 `stream.fail err="cardkit.card.create returned no card_id"`，群里**没有**确认卡或结束时间卡，草稿已落盘（`drafts[]`，无 `cardMessageId`）。用户看到的是「已提交」然后什么都没有。
- 看板：之后每一次 board refresh（每次 fire、settle、暂停、link 恢复）都 `auto.fail _event=board` 同一错误，看板从未出现、从未置顶。
- 03:40:19、03:49:02、03:50:23（每次 link 恢复）`flushPendingDraftCards` 重试无卡草稿，同一错误，且抛出后中断本轮 flush 剩余草稿和随后的 `board.refresh()`。
- 探针：同一份卡片 JSON 直接调 `cardkit.v1.card.create` → `code 200610 "body is nil"`；最小 `{schema:"2.0", body:{elements:[{tag:"markdown",content:"x"}]}}` → 成功拿到 `card_id`。

## 根因（已在 a27e564 只读核对）
- 三张自动化卡都用旧版 1.0 结构：顶层 `elements` + `config.wide_screen_mode/update_multi` + `div/lark_md` + `tag:'action'` 按钮组，无 `schema`、无 `body`。各自复制了一份 `shell()`/`button()`/`actions()`：`src/automations/confirm-card.ts:30`、`src/automations/end-card.ts:28`、`src/automations/board-card.ts:36`（同样的 1.0 写法源自 `src/card/templates.ts:26`）。
- 它们都经 `sendManagedCard`（`src/card/managed.ts:30`）发送，第一步就是 `channel.createCard(card)`（:36）= `cardkit.v1.card.create`，只接受 2.0 卡片实体。`templates.ts` 的 `/ws`、`/status` 卡能用，是因为它们走 `channel.send(chatId, { card })` 原始消息，不走 cardkit。
- `sendManagedCard` 只在 **send** 失败时回退到 raw card（:42-51）；**createCard** 失败直接抛出，没有任何回退或日志字段。
- SDK `createCardInstance`（`@larksuite/channel` dist `index.mjs` ~4534）在没有 `card_id` 时抛 `LarkChannelError("unknown", "cardkit.card.create returned no card_id")`，**丢掉了飞书的 `code`/`msg`**，所以我们的日志里看不到 200610，`classify()` 也只能得到非 link 的 `unknown`。
- 草稿先 `saveDraft` 再发卡（`src/automations/command.ts:459-472`、`:485-500`），发卡失败时草稿留着且无卡；`flushPendingDraftCards`（:508）每次 link 恢复都按「无 `cardMessageId` = 掉线时没发出去」去重发，单条失败就抛出，后面的草稿和 `board.refresh()`（`src/bot/channel.ts:906-924`）都不跑了。
- 看板更新 `updateCardById`（`src/automations/board.ts:158`）同样需要 2.0 实体；就算 create 侥幸成功，1.0 JSON 的 update 也会失败。
- 测试没发现：`tests/helpers/fake-channel.ts:287` 的 `createCard` 接受任何 JSON；`tests/unit/card/managed.test.ts` 也是 `vi.fn(async () => ({cardId}))`。

## 要做
1. **三张卡全部改为 schema 2.0**：`{ schema: '2.0', config: { summary: {...} }, header: {...}, body: { elements: [...] } }`。
   - 仓库里**没有**现成的共享 2.0 builder；能用的 2.0 卡各自手写：`src/card/account-cards.ts`（`accountCurrentCard` :14、表单 :48 起）、`src/card/config-card.ts`（`form` + `column_set` 按钮 + `form_action_type:'submit'`，:110-320）、`src/card/run-renderer.ts`（`markdown`/`noteMd`/`stopButton` 用 `behaviors:[{type:'callback', value}]`，:178-198）。把这套写法抽成一个小模块（例如 `src/card/v2.ts`：`card2({title, summary, elements})`、`md()`、`note()`、`hr`、`callbackButton()`、`buttonRow()` 用 `column_set`/`column`、`form()`），三张自动化卡改用它；三份私有 `shell/button/actions/divMd` 删除。`account-cards`/`config-card`/`run-renderer` 是否迁过来可选，不在本票验收里。
   - 按钮：`tag:'action'` 在 2.0 里不可用，改为 `column_set` 里的 `button`，回调值放 `behaviors: [{ type: 'callback', value: { cmd, auto_token } }]`。dispatcher 读 `evt.action.value`（`src/card/dispatcher.ts:93`），`/config` 的 2.0 按钮已证明 SDK 会把 behaviors 的 value 放进 `action.value`，所以 `auto.*` 路由不用改。
   - 结束时间卡：自定义日期 `input name:'end_at'` 必须放进 `form`，「提交」按钮 `form_action_type:'submit'` + callback `{cmd:'auto.end.custom', auto_token}`；输入值走 `raw.action.form_value.end_at`（`readEndInput`，dispatcher.ts:551 已支持，`includeRawEvent: true` 已开，channel.ts:426）。四个预设按钮和「取消」放在 form 外（或确认 2.0 允许 form 内非 submit 按钮后再放进去，二选一并测试）。end-card 的 nonce 逻辑（`verify({consume:false})` + `claimNonce`/`consume`/`releaseNonce`，dispatcher.ts:427-457）不动；必须验证：预设点一次→出确认卡；同卡再点→`AUTO_END_BUSY`/失效提示，不出第二张确认卡。
   - 看板：Pause/Resume/Delete 签名 token 不变（`BoardActionAuth`），只换外壳。状态块仍用 `text_size:'notation'` 的 markdown（2.0 合法）。**同时修 `simplifiedBoardRender`**（`src/automations/status-block.ts:15`，:83 只下钻 `card/elements/header/title`，不认 `body`、`column_set.columns`、`form`）——否则 A5 的「第三方读者看到的状态块」测试在 2.0 下会读不到。用 A11 实测的 2.0 消息读回形状（`{"body":{"elements":[...]}}`）做 fixture。
2. **创建失败必须可见，不能留下静默草稿。** 从用户角度：用户发出创建请求，要么看到确认/结束卡，要么看到一句明确的失败说明，二者必居其一。
   - 把飞书错误码带出来：`createCard` 失败要拿到 `code`/`msg`（扩展现有 `patches/@larksuite__channel@0.7.1.patch` 让 `createCardInstance` 把响应 `code/msg` 挂在错误上，或在 `managed.ts` 里直接调 `rawClient.cardkit.v1.card.create` 并自行抛带码的错误；二选一）。`log.fail('card', err, { step: 'managed-create', code, msg })`。
   - `postConfirmCard`/`postEndCard` 失败按类分流（用现有 `classify()`）：
     - `link`（网络/5xx/超时/限流）：草稿保留，`log.info('auto','draft.card-deferred')`，交给 link 恢复时的 `flushPendingDraftCards` 重发（这是 A1' 的既有设计）。
     - 其它（`rejected`/`unknown`，含 200610）：**删除该草稿**（`takeDraft`），`log.warn('auto','draft.card-failed', {draftId, code})`，并在原请求消息下回一条纯文本（不是卡片）：`确认卡片发送失败（飞书错误 <code>），未创建任务。请稍后重试。`。不能让一份用户看不见、也点不到的草稿躺 24 h。
     - not-in-chat 维持现状（`abandonIfNotInChat`）。
   - `flushPendingDraftCards` 每条草稿单独 try/catch，同样分流；一条失败不影响后面草稿，也不阻断随后的 `board.refresh()`。
   - 看板 create/update 失败：日志带 `code`；非 link 错误不要每次 refresh 都重打同一个注定失败的请求刷日志（同一 `chatId` 同一卡片形状失败后，下次内容变化前不重试，或简单限频，实现者定）。
   - 不加「createCard 失败就改发 raw card」的回退：格式错误应该在测试里暴露，而不是在线上被掩盖。
3. 斜杠命令路径与自然语言路径同一处理（都经 `postConfirmCard`/`postEndCard`）。

## 验收
- [ ] 新增 2.0 形状校验 helper（测试侧，`tests/helpers/card-schema2.ts`）：要求 `schema === '2.0'`、`body.elements` 为数组、顶层无 `elements`、全树无 `tag:'action'`、按钮有 `behaviors[].type==='callback'` 且 value 含 `cmd`、`input` 只出现在 `form` 内、`form` 内的 submit 按钮有 `form_action_type`。**`fake-channel.createCard` 和 `updateCardById` 调用这个校验，不合格就按飞书方式抛错（code 200610）**，不再接受任何 JSON。
- [ ] 单测：`automationConfirmCard`、`automationEndCard`、`automationBoardCard`（空看板「暂无」、有暂停项、有已错过/已跳过行）全部通过校验；`/ws`、`/status` 等仍走 raw send 的卡不经过这个校验，不受影响。
- [ ] 单测：`simplifiedBoardRender` + `parseStatusBlock` 能从 2.0 看板（对象形态和 A11 实测的消息读回 JSON 形态）读出 `v:1` 状态块，含 `id/paused/updatedAt`。
- [ ] 单测：fake 让 `createCard` 抛 200610 → 草稿被删除、请求消息下有一条含「未创建任务」的纯文本、日志 `draft.card-failed` 带 code；让它抛 link 类错误 → 草稿保留、无群消息，恢复后 flush 发出卡片。两条无卡草稿第一条失败时第二条仍被处理，`board.refresh()` 仍被调用。
- [ ] 单测：end 卡预设点击 → 确认卡；同卡第二次点击不出第二张确认卡；自定义日期经 `form_value.end_at` 提交生效；看板 Pause→Resume→Delete 回调仍正确（复用现有测试，只换卡片形状）。
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。
- [ ] **Bot Arena 实测**（A11 测试 bridge，编排者通过桌面真实点击）：确认卡、结束时间卡、看板三张都真实出现；点「是」生成任务；结束卡点预设与自定义日期各一次；看板置顶、第二个成员点暂停/删除生效。证据按 A11 规则脱敏。

## A11 需重跑的场景
S1 创建全流程（`/auto new` 由编排者桌面发送，见 A11 备注）→ 确认卡点「是」；A2 周期创建 + 结束时间卡（预设 + 自定义）；A4 看板置顶 / 手动取消置顶后重新置顶 / 第二成员 Pause/Delete；A5 只读 monitor 读状态块；A6 自然语言创建（缺结束时间 → 结束卡）；A1' 掉线时创建 → 恢复后补发卡片。
