# A7: Bot removed, p2p, observability

**What to build:** bot removed from group / group disbanded → that group's tasks deleted, board not written; p2p `/auto` replies 仅支持群; structured events auto.draft/confirmed/rejected/fire/missed/result/paused/deleted/expired/policy-guard/board.repin without task text.

**Blocked by:** A4

**Status:** ready-for-agent

- [ ] Bot-removed event or not-in-chat send error deletes that group's tasks.
- [ ] Every lifecycle step emits exactly its event; no task body in logs.
