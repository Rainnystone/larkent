# A0d: `/auto new` and the signed confirm card

Spec: [../../automations.md](../../automations.md) §3, §2, ADR-005

**What to build:** `/auto new <时间表> | <名称> | <任务>` (and `/auto new agent ...`) in a group → bridge-rendered confirm card (kind, schedule, timezone, next 3 fires, end, task text verbatim, identity, "约每月 N 次", weekday ignores 调休) → any human who passes the group's access taps 是 → item stored and armed in the A0c scheduler. New signed card action binding draft + chat + action + one-time nonce + TTL, no operator binding, no running run required, only bridge-registered cards; built on the signing base already on master. Bot messages and automation-run proposals are ignored. p2p replies 仅支持群. Validation failures and lead time < 10 min / > 1 y get a scripted message.

**Blocked by:** A0a, A0b

**Depends on #47:** soft — #47 reworks interruption-notice actions into Continuations and touches command/card-action routing; the confirm action only shares the signing base, so expect a rebase, not a redesign.

**Status:** ready-for-agent

- [ ] Card content matches the stored item verbatim.
- [ ] Draft expires after 24 h; stale, duplicate or forged taps have no effect and say so.
- [ ] A bot-sent `/auto new` creates nothing.
- [ ] With a fake sender, the confirmed one-shot fires once at its instant (scheduler from A0c).
