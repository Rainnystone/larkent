# A26 — 重发后把旧看板结算为无按钮说明；点非当前看板给专门提示；A21 pending 改为列表，不留永久双置顶

Status: ready-for-agent
Severity: **medium**（A11 r5 2026-10-18：重发留下的旧看板按钮看起来完全可用，点了只得到「此确认已失效。」；A21 的单个 pending id 在「取消置顶失败 + 连续两次重发」时会永久留下两张置顶看板，临时测试已复现）
Blocked by: A25（同样改 `src/automations/board.ts` 的重发路径）
Track: 推到现有 code 分支 `feat/automations-v2`（PR #49），**#49 合入前完成**，不开新 PR
Spec: [../../automations.md](../../automations.md) §7（每 bot 每群一张卡；重发时结算旧卡；点非当前看板）
Amends: [A21](A21-board-rebind-after-pin.md)（pending id 改为列表）

## 场景（A11 r5，真实触发，2026-10-18 UTC+8）

13:05–14:30 之间看板重发了四次（见 [A25](A25-board-sequence-retry-in-place.md)），群里留下 om_…c357、om_…8776 等旧看板。旧卡上【暂停/恢复】【删除】仍然显示、可点：
- 在线 bridge（`7c29b6a`）：`dispatcher.ts:517` `findBoardByMessageId` 只匹配当前绑定，点旧卡得到 toast「此确认已失效。」，任务不变。措辞是「确认」，不贴合看板，成员不知道该去哪里操作。
- head `5552726`（A21）：`store.ts:485-489` 把 `pendingUnpinMessageId` 也算作登记过的看板。在「新卡已置顶、旧卡还没取消置顶」的窗口里，点旧卡**会真的执行**暂停/恢复/删除，但之后只刷新新卡，旧卡内容停在旧状态，看起来像点了没反应。

CardKit 卡片实体 14 天过期（200750），周期任务最长 1 年，所以长期看板**必然**会重发，旧卡问题是常态。

## 触发

1. 任何一次看板重发（A25 之后只剩 200740 / 200750 / 消息已删除）之后，点旧卡按钮。
2. **A21-edge**（高概率理论问题，临时测试已复现，本次 A11 未观察到）：A 已置顶 → 重发 B，B 置顶成功，取消 A 置顶失败（pending = A）→ 下一次 B 又需要重发 → 重发 C：pending 仍是 A，**B 被遗忘但仍置顶**。临时测试输出 `after resend2 pins [B, C] pending undefined`；第 3 次刷新后仍 `[B, C]`，`findBoard(B) miss`。违反 A21 验收「没有已置顶的卡丢失 message id」。

## 根因（`5552726`）

- `board.ts:258-268` `retainedUnpinMessageId` 只保留**一个** pending id，且优先保留更老的。
- 重发路径只管置顶，不更新旧卡内容和按钮（A21 范围如此）。
- `dispatcher.ts:517` 对不在登记里的看板按钮返回通用的「此确认已失效。」；`store.ts:485-489` 让 pending 旧卡在窗口内可执行动作。
- 看板按钮 token（`board-auth.ts`）只绑 chat + item + action，TTL 400 天，本身不过期，完全靠 message 登记拦截。

## 要做

**(a) 重发时结算旧卡**
- 新卡置顶成功、绑定换成新卡之后（A21 顺序不变），把旧卡尽力更新为**无按钮**的说明卡：标题保持，正文一行「此看板已更新，请查看置顶的新看板。」，不含任何按钮（也不含 `disabled` 按钮）。
- 更新用 A25 的单调 sequence。200750 等实体已过期的情况下大概率失败：只记 `code` / `msg`，不立即重试；随 pending 列表在后续刷新里再试，取消置顶成功后停止。

**(b) 点非当前看板**
- 决定：**pending 窗口内的旧卡也不执行动作**（取消 A21 引入的「pending 旧卡可执行」行为），统一引导到新卡。
- 点任何非当前绑定的看板按钮（pending 或已释放）→ toast「此看板已更新，请使用置顶的新看板。」，不改任务、不写卡。识别依据是按钮 token 的看板动作类型（不是确认卡 nonce），所以不会落到「此确认已失效。」。
- 确认卡 / 提示卡的失效 toast 不变（A20 / A22）。

**(c) pending 改为列表（修 A21-edge）**
- store 字段改为 `pendingUnpinMessageIds: string[]`（按 message id 去重，保留每项的 cardId 与 sequence 以便结算）。读取旧字段 `pendingUnpinMessageId`（单个字符串）时迁移为单元素列表；写回只写新字段。
- 重发时把**当前绑定的** message id 加入列表（不替换已有项）。
- 每次刷新逐个尝试取消置顶（以及未结算的先结算），成功一个移除一个；失败的留在列表里。
- 列表不静默丢弃任何仍可能置顶的 id。超过 5 项时写一条 `auto.board.pending-overflow` 警告，但不删。

## 验收

- [ ] 先写失败测试，再实现：
  - **A21-edge 回归**（复现 r5 临时测试场景，用 200750 触发重发，因为 A25 之后 300317 不再重发）：A 置顶 → 重发 B（取消 A 置顶失败）→ B 再 200750 → 重发 C（取消置顶继续失败）→ 断言 store 的 pending 列表含 A、B；放开取消置顶后再刷新一次 → pins 只有 [C]，pending 为空。任一时刻没有已置顶的卡不在 store 里。
  - 重发成功后旧卡收到一次结算更新：无按钮，含「此看板已更新」；用的 sequence 单调。
  - 旧卡结算失败（200750）→ 只记日志，绑定仍是新卡，旧 id 留在 pending 里，下次刷新再试；取消置顶成功后不再尝试。
  - 点 pending 旧卡的【暂停】→ toast「此看板已更新，请使用置顶的新看板。」，任务不变，不写任何卡。
  - 点已释放旧卡的【删除】→ 同上。
  - 点确认卡的已失效按钮 → 仍是「此确认已失效。」（不被新文案影响）。
  - 旧字段 `pendingUnpinMessageId: "A"` 的 store 加载后等于 `pendingUnpinMessageIds: ["A"]`。
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。
- [ ] Bot Arena 实测（A11）：用测试注入让当前看板 card.update 返回 200750 → 新看板置顶，旧看板变成无按钮的「此看板已更新」说明卡，群里只有一张置顶看板；在真实客户端点一张更早留下的旧看板（如有）→ 看到新 toast，任务不变。再注入一次「取消置顶失败 + 连续两次重发」，放开后群里只剩一张置顶看板。

## 不做

- 不改 300317 / sequence 逻辑（A25）。
- 不改看板按钮权限（A18，及 Spec §3 / §7 的可用范围说明）。
- 不撤回旧卡消息（结算为说明卡即可）。

## A11 需重跑的场景

A21 的「置顶失败一次」场景；注入 200750 的重发场景；点旧看板按钮。
