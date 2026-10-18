# A21 — 看板重发时保留旧绑定，等新卡置顶成功再换

Status: ready-for-agent
Severity: **medium**（Codex r7 P2 on PR #49，判定 ACCEPT：置顶会短暂失败。2026-10-18 13:05 实测飞书返回 300317，触发了重发）
Blocked by: A20（同样改 `src/automations/board.ts`）
Track: 推到现有 code 分支 `feat/automations-v2`（PR #49），**#49 合入前完成**，不开新 PR
Spec: [../../automations.md](../../automations.md) §7（卡片无法更新时重发并置顶、取消旧卡置顶）

## 场景

看板无法原地更新（A20 (a)：card.update 返回 `code != 0`）时，`patchOrResend` 会发一张新卡并置顶。按现在的代码（`7c29b6a`，`src/automations/board.ts` 约 120 行），新卡的绑定（message id / card id / sequence）在 `ensurePinned` 成功**之前**就写进了 store。

## 触发

新卡发出后 `ensurePinned` 失败，例如飞书短暂报错（13:05 实测 300317）。这时 store 已经指向新卡，旧看板的 message id 丢了，以后既不能取消它的置顶，也不会再更新它。群里会留下过期的看板，或者同时有两张置顶看板。

## 要做

- 新卡置顶成功之后，才把绑定换成新卡，再取消旧卡的置顶。
- 置顶失败时：store 保留旧绑定，不取消旧卡的置顶，记录 `code` / `msg`。新发出、但没置顶的卡要么撤回，要么作为待置顶候选记下来；选哪种写进 PR 说明，并用单测锁住。下次刷新时重试（重发或置顶），不能有一张卡被永久遗忘。
- 取消旧卡置顶失败时，只记日志，不回滚新的绑定。

## 验收

- [ ] 先写失败测试：mock `ensurePinned` 失败，断言 store 里还是旧绑定，旧卡没有被取消置顶，日志有 `code` / `msg`。
- [ ] 同一测试里，下一次刷新且置顶成功时：绑定换成新卡，旧卡恰好取消置顶一次。
- [ ] 测试：置顶成功的路径上，顺序是 先置顶 → 再写绑定 → 再取消旧卡置顶。
- [ ] 任何失败序列下，都不会出现两张被 store 记录的置顶看板，也没有已置顶的卡丢失 message id。
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。
- [ ] 修复 commit 回复到 #49 的 Codex r7 线程。

## 不做

- 不改 card.update 的检查逻辑与 toast（A20）。

## A11 需重跑的场景

用测试注入让一次置顶失败：旧看板仍然置顶，下一次刷新后只有新看板置顶。
