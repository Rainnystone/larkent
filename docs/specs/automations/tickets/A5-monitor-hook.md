# A5: Monitor hook and local status file

**What to build:** a local status file (source of truth, atomic) per profile; the board renders it as a visible machine-readable text block (note element): `{v, bot, items:[{nextFireAt,lastFireAt,lastStatus,endAt,missed}]}` in UTC ms; no Feishu IDs, task content or creator.

**Blocked by:** A3, A4

**Status:** ready-for-agent

- [ ] Block is present in the message content as read by another app (simplified render), parses as JSON with v=1.
- [ ] Values match the status file after fire, missed, pause and delete.
- [ ] Snapshot test proves no ID-shaped strings, no task text, no creator name.
