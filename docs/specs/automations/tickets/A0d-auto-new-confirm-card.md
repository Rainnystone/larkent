# A0d: `/auto new` and the signed confirm card

Spec: [../../automations.md](../../automations.md) §3, §2, ADR-005/020

**What to build:** `/auto new <时间表> | <名称> | <任务>` (and `/auto new agent ...` for an agent task) in a group → bridge-rendered confirm card (task type, schedule, timezone, next 3 fires, end, task text verbatim, identity, "约每月 N 次", weekday ignores 调休) → any human who passes the group's access taps 是 → item stored (chat binding, `createdBy`, name, task text, timezone, cwd snapshot for agent tasks; see A0b) and armed in the A0c scheduler. Bot messages and automation-run proposals are ignored. p2p replies 仅支持群. Validation failures and lead time < 10 min / > 1 y get a scripted message.

**Signing:** model the confirm action on `NoticeActionAuth` (src/bot/interruption-notice.ts:104-184): payload of turn/scope/chat/action/fingerprint + expiry + one-time nonce, **no operator binding**, nonce consumed in `verify`. Use a new action family bound to draft + chat + action + nonce + TTL. Do **not** use `CallbackAuth` (src/card/callback-auth.ts:17-25), which binds `operatorOpenId` and `runId`: a confirm card has no running run and any group member may tap. Route a new `auto.*` command in the card dispatcher next to the existing `notice.continue` / `notice.dismiss` branch (src/card/dispatcher.ts:113). Only bridge-registered cards are accepted.

**Blocked by:** A0a, A0b

**Status:** ready-for-agent

- [ ] Card content matches the stored item verbatim.
- [ ] Draft expires after 24 h; stale, duplicate or forged taps have no effect and say so.
- [ ] A tap by a second member (not the creator) confirms; the token carries no operator.
- [ ] A bot-sent `/auto new` creates nothing.
- [ ] With a fake sender, the confirmed one-shot fires once at its instant (scheduler from A0c).
