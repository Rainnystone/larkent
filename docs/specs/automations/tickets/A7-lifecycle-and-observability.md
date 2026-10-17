# A7: Bot removed / chat gone, DM, observability

Spec: [../../automations.md](../../automations.md) §8, §10, ADR-012

**What to build:** bot removed from the group or group disbanded (member event, or a send rejected as "not in chat") → that group's tasks deleted, board no longer written, one log line; p2p `/auto` replies 仅支持群; structured events `auto.draft/confirmed/rejected/fire/missed/catch-up/wake.already-started/result/paused/deleted/expired/policy-guard/board.repin` without task text.

**Blocked by:** A4

**Depends on #47:** soft — classifying "not in chat" uses #47's single Feishu error classifier (rejected vs link) once merged; the member-event path does not depend on it.

**Status:** ready-for-agent (rejection path after #47)

- [ ] Bot-removed event or not-in-chat rejection deletes that group's tasks; no catch-up is attempted for them.
- [ ] Every lifecycle step emits exactly its event; no task body in logs.
