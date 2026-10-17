# A9: Agent safety — bot-only identity and tool whitelist

Spec: [../../automations.md](../../automations.md) §6

**What to build:** automation runs use a bot-only lark-cli identity and the automation prompt variant; the bridge whitelist stops personnel/org calls or user-identity requests with `StopRequest` `policy-guard` → `interrupted(policy-guard)`, a notice in the group, task paused (shown as `paused` in the status block); redacted audit log.

**Blocked by:** A8

**Depends on #47:** hard (via A8) — also extends the run-outcome classification #47 changes.

**Status:** blocked (#47)

- [ ] Member add/remove, create chat, or user identity in a run → blocked, paused, audited.
- [ ] Allowed reads and sending to the same group succeed.
- [ ] Docs state this is defence in depth, not a security boundary.
