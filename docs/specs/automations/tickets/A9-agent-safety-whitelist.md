# A9: Agent safety — bot-only identity and tool whitelist

**What to build:** automation runs use a bot-only lark-cli identity and automation prompt variant; bridge whitelist stops personnel/org calls or user-identity requests with `StopRequest` `policy-guard` → `interrupted(policy-guard)`, notice, task paused; redacted audit log.

**Blocked by:** A8

**Status:** ready-for-agent

- [ ] Member add/remove, create chat, or user identity in a run → blocked, paused, audited.
- [ ] Allowed reads and sending to the same group succeed.
- [ ] Docs state this is defence in depth, not a security boundary.
