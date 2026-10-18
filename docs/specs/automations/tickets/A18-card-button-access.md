# A18 — 自动化卡片按钮不受 allowedUsers 限制；被拒的点击必须有 toast

Status: ready-for-agent
Severity: **medium**（Bot Arena 实测 2026-10-18：名单外成员点按钮，转圈后静默回弹）
Blocked by: —
Track: #49 合入后单独做，dual-track 跟进；**不属于 #49**
Spec: [../../automations.md](../../automations.md) §7（看板「群里任何人可点」）、§3（确认卡「群里任何人点『是』即生效」）、ADR-007

## 现象（Bot Arena，2026-10-18 实测）

群 profile 配了 `access.allowedUsers`。一个不在名单里的群成员在自动化卡片上点【是】、【暂停】或【删除】：按钮转圈，然后静默回弹。没有 toast，卡片不更新，也没有任何提示。

## 根因

- `src/card/dispatcher.ts:115-129` 对卡片动作先跑 `evaluateAccess`。不通过时记一条 `skip-not-allowed-user` 日志，然后**不返回任何响应**。
- 飞书拿不到回调响应，客户端只能转圈后回弹。
- 这和 spec 冲突：§7 看板按钮、§3 确认卡都写的是「群里任何人可点」（ADR-007）。A0d 写成了「any human who passes the group's access taps 是」，措辞不一致。

## 决定

- 自动化看板按钮（暂停/恢复、删除），以及确认卡、结束卡上的按钮，按 spec §7「群里任何人可点」处理，**不受 `allowedUsers` 限制**。
- `allowedUsers` 只管谁能和 bot 对话、谁能创建任务（`/auto new`、自然语言创建）。
- 卡片动作因为其它原因被拒（签名无效、过期、重复点击、非 bridge 注册卡片、群不匹配等）时，必须返回 toast（例如「无权限操作」或具体原因），**不允许静默**。

## 要做

- dispatcher 里 `auto.*` 卡片动作跳过 `allowedUsers` 检查。签名/nonce/TTL/群绑定校验（A0d、A4）保持不变。
- 非 `auto.*` 卡片动作仍按现有的 access 规则处理，但被拒时返回 toast，不再无响应返回。
- 改 spec 措辞，让它前后一致：A0d 的「any human who passes the group's access taps 是」改为「any group member taps 是（not gated by `allowedUsers`）」。§7 / ADR-007 补一句：`allowedUsers` 不限制自动化卡片按钮。

## 验收

- [ ] 单测（dispatcher）：配了 `allowedUsers` 的群，名单外用户点 `auto.*` 的确认、暂停、删除按钮，动作生效并返回正常响应。
- [ ] 单测：签名无效、过期、重复的 `auto.*` 点击返回 toast，不是空响应。
- [ ] 单测：名单外用户点非自动化卡片动作，返回 toast（例如「无权限操作」），不是空响应。
- [ ] spec：A0d 与 §7 / ADR-007 措辞一致。
- [ ] 实测：Bot Arena 里用一个不在 `allowedUsers` 名单里的账号点【暂停】和【删除】，卡片原地更新；点一次过期按钮，看到 toast。

## 不做

- 不改 `allowedUsers` 对对话和创建任务的限制。
- 不给看板按钮加创建者限制（ADR-007 已否决）。
- 不放进 #49。

## 共同验收

- [ ] 先写失败测试，再实现。
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。
