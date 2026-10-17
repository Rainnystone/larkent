# A1': Reminder delivery via the Outbox; missed on link down

Spec: [../../automations.md](../../automations.md) §4, §5, ADR-013/016/018

**What to build:** the real `FireSender` for reminders and the real missed notifier from A0c. The text is "⏰ 名称：任务文本" (plus "（补跑，原定 HH:MM）" for a catch-up); the missed notice lists each 已错过 original time. Both are staged in and delivered through the **Outbox**, so a failed send is redelivered after recovery exactly once. A fire whose instant arrives while **FeishuLink** reports down is not started (not staged, not marked started) and stays missed; the scheduler's link-recovered trigger is wired to `link.onRecovered` (src/bot/feishu-link.ts:35; today subscribed at src/bot/channel.ts:733-736) and applies the A0c catch-up rule. Never uses Continuations. This is the first ticket where a reminder reaches a real chat.

**Outbox = the turn journal.** Each fire (and each missed notice) gets its **own `TurnJournalEntry`** (src/bot/turn-journal.ts:73-103) with `turnId` derived from the fire key; `deliveryId` comes from `replyDeliveryKey(turnId)` and must stay within `FEISHU_DELIVERY_ID_MAX_CHARS = 50` (src/bot/turn-journal.ts:1060). Longer ids are truncated, not hashed (`clipDeliveryId`, :1078-1080), so design the derived id to fit without clipping. `TurnReply.replyTo` is required (src/bot/turn-journal.ts:31-43), and the entry also requires `messageIds` / `senderId` / `initiatorId`: define their values for a fire that has no triggering message (a top-level send).

**Read-back limit (accepted).** After the 1-hour uuid window, redelivery reads the chat back and matches `parent_id === reply.replyTo` (src/bot/feishu-delivery.ts:91-104 and :203-204). A top-level fire has no parent, so it **can't be read back**: a send whose receipt was lost and whose redelivery happens more than 1 h later could post twice. That is a theoretical risk with no real trigger, accepted per ADR-018. No handling and no ticket.

**Blocked by:** A0c, A0d

**Status:** ready-for-agent

- [ ] Fake clock fires → exactly one text in the recording channel.
- [ ] Send fails with a link error → stays staged; after recovery it is delivered once; no catch-up duplicate.
- [ ] Link down at the instant → nothing staged; after recovery within 24 h one catch-up with "补跑，原定 HH:MM"; after > 24 h none, missed +1, one missed notice in the chat, one log entry.
- [ ] Kill/restart around a fire → the chat holds one message.
- [ ] Derived `deliveryId` for the longest realistic fire key is ≤ 50 chars and unique per fire.
