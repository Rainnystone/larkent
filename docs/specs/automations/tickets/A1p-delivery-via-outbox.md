# A1': Reminder delivery via the #47 Outbox; missed on link down

Spec: [../../automations.md](../../automations.md) §4, §5, ADR-013

**What to build:** the real `FireSender` for reminders: "⏰ 名称：任务文本" (plus "（原定 HH:mm）" for a catch-up) staged in and delivered through the **#47 Outbox** once merged, with a delivery key derived from the fire key, so a failed send is redelivered after recovery exactly once. A fire whose instant arrives while the **#47 FeishuLink** reports down is not started (not staged, not marked started) and stays missed; the scheduler's link-recovered trigger is wired to the link's recovery signal and applies the A0c catch-up rule. Never uses Continuations. This is the first ticket where a reminder reaches a real chat.

**Blocked by:** A0c, A0d

**Depends on #47:** hard — needs the Outbox (stage → send → delivered → redeliver) and the link up/down + recovered contract from #47 once merged.

**Status:** blocked (#47)

- [ ] Fake clock fires → exactly one text in the recording channel.
- [ ] Send fails with a link error → stays staged; after recovery it is delivered once; no catch-up duplicate.
- [ ] Link down at the instant → nothing staged; after recovery within 24 h one catch-up with "原定 HH:mm"; after > 24 h none, missed +1.
- [ ] Kill/restart around a fire → the chat holds one message.
