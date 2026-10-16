# A1: Tracer — one-shot reminder end to end

Spec: [../../automations.md](../../automations.md)

**What to build:** `/auto new 一次 <绝对时间> | 名称 | 文本` in a group → bridge-rendered confirm card (kind=reminder, absolute time, timezone) → anyone taps 是 → stored (schemaVersion 1, atomic) → at that instant the scheduler fires and one text message is delivered through the link-recovery Outbox. Feature behind `automations.enabled` (default off). Includes the new signed confirm action (draft + chat + nonce + TTL, no operator binding).

**Blocked by:** link-recovery code PR merged (Outbox). Otherwise none.

**Status:** ready-for-agent

- [ ] With a fake clock, advancing to the instant posts exactly one reminder; nothing before it.
- [ ] Draft expires after 24 h; stale/duplicate taps have no effect and say so.
- [ ] Proposals from bot messages are ignored.
- [ ] Lead time < 10 min or > 1 year is rejected with a scripted message.
- [ ] Flag off → behaviour identical to baseline; older code ignores the store.
- [ ] Reminder send failure stays staged and is redelivered on recovery (once).
