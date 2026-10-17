# A9: Agent-task safety — bot-only identity and tool whitelist

Spec: [../../automations.md](../../automations.md) §6

**What to build:** automation runs use a bot-only lark-cli identity and the automation prompt variant; the bridge whitelist stops personnel/org calls or user-identity requests with `StopRequest` `policy-guard` → `interrupted(policy-guard)`, a notice in the group, task paused (shown as `paused` in the status block); redacted audit log.

**Code anchors (master@d056198):**
- Add `{ type: 'policy-guard' }` to the `StopRequest` union (src/bot/run-outcome.ts:9-20) and carry it through outcome classification and notice copy.
- The identity preset is profile-wide today: `LarkCliIdentityPreset = 'bot-only' | 'user-default'` (src/config/profile-schema.ts:138) and `effectiveLarkCliIdentity` returns `profile.larkCli.identityPreset` (:209-220). Automation runs need a **per-run override** to `'bot-only'` that doesn't change the profile or human runs.
- **Caveat:** the agent still has a full shell. This is defence in depth, not a security boundary. Agent tasks stay off in production until this ticket is verified.

**Blocked by:** A8

**Status:** ready-for-agent

- [ ] Member add/remove, create chat, or user identity in a run → blocked, paused, audited.
- [ ] Allowed reads and sending to the same group succeed.
- [ ] A human run in the same profile keeps the profile's identity preset.
- [ ] Docs state this is defence in depth, not a security boundary.
