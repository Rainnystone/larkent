# A2: Recurring creation, scripted end card, expiry

Spec: [../../automations.md](../../automations.md) §2, §3, ADR-002/003/017

**What to build:** the rest of recurring support on top of A0a's grammar: `/auto new` with daily / weekday / weekly / every-N schedules; a recurring draft without `endAt` gets the deterministic **scripted card** (common options + text input, no agent) before any confirm card; after the last fire or past `endAt` the item is deleted (no renewal message, no retention), including after a catch-up of its final fire. Exception per ADR-017: a one-shot that was not caught up keeps `nextFireAt = 0` and shows 已错过 for 24 h before expiry. Timezone from the profile's `automations.timezone`, then `Asia/Shanghai`.

**Blocked by:** A0d

**Status:** ready-for-agent

- [ ] Missing end → scripted card; after the end is supplied the confirm card appears.
- [ ] Reminder interval < 10 min and agent-task interval < 1 h rejected with the scripted message.
- [ ] Confirm card states weekday ignores 调休 and shows the next 3 fires.
- [ ] After the last fire / `endAt` the item is deleted and leaves the status file; the automations log keeps its records.
