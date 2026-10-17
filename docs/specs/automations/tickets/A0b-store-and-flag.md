# A0b: Automations store and feature flag

Spec: [../../automations.md](../../automations.md) §1 (automation id, fire key, started), §2, §9

**What to build:** per-profile automations file (`schemaVersion: 1`, atomic write, supervisor-owned like the turn journal, survives `/reconnect` and bridge swap): items with per-profile **auto-increment short `id` that is never reused**, kind, schedule, timezone, `startAt`/`endAt`, `nextFireAt`, `lastFireAt`, `paused`, `missed`, `lastStatus`, bounded fire history; the set of **started fire keys** persisted atomically before execution; drafts with 24 h TTL. A future `schemaVersion` is refused without overwriting; older code ignores the file. Profile flags `automations.enabled` and `automations.agentKind`, both default off.

**Blocked by:** None — can start immediately.

**Depends on #47:** soft — #47 reshapes the profile reliability settings; adding the `automations` settings is additive but may need a rebase when #47 lands. No behavioral dependency.

**Status:** ready-for-agent

- [ ] Flag off → bridge behaviour identical to baseline; no file created.
- [ ] Ids are monotonic across delete and restart (delete 3, create → 4).
- [ ] `markStarted(fireKey)` is durable before it returns; a second call reports already-started.
- [ ] Future schemaVersion → load refused, original file untouched.
- [ ] No Feishu ID or secret is written to the status file (the chat binding lives only in the automations file).
