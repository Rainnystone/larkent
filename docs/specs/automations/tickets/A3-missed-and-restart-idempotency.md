# A3: Missed fires and restart idempotency

**What to build:** fire only at the absolute instant; if the process was not running, the link is down, or the fire cannot start, record `missed` (count + event) and advance — no grace, no catch-up, no retry after reconnect. Persist the fire key before executing so restarts never repeat an instant.

**Blocked by:** A1

**Status:** ready-for-agent

- [ ] Clock jumps over 3 instants (simulated sleep) → 0 messages, missed=3, nextFireAt is the next future instant.
- [ ] Kill/restart around a fire → the instant runs at most once.
- [ ] Fire during link down → missed, nothing sent after recovery.
