# A0a: Schedule pure functions

Spec: [../../automations.md](../../automations.md) §1, §2, §4 (miss rule), ADR-001/002/003/013/016/017

**What to build:** a pure module, no I/O, injected `now`: parse a structured schedule (one-shot; daily / weekday / weekly times; every N min/hour with optional `[from, to)` window incl. cross-midnight) with an IANA timezone; validate floors (reminder lead/interval ≥ 10 min, agent-task interval ≥ 1 h, one-shot ≤ 1 y ahead, recurring `endAt − startAt ≤ 1 y`, recurring requires `endAt`); compute next fire after an instant and the next 3 fires; compute "约每月 N 次"; the **miss rule** `isMissed(item, now)` and the **catch-up decision** `planCatchUp(item, now)` → `{ run?: fireAt, missedFires: fireAt[] }` (≤ 24 h, latest missed instant only, every other missed instant listed individually so the caller can leave a trace for each; paused never); fire key formatting (`id@fireAt`).

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Table tests run in a UTC host: weekday skips Sat/Sun; window 22:00–02:00 belongs to the start day; DST gap shifts to the next valid minute; DST overlap fires once.
- [ ] Floors and 1-year caps reject with a typed reason (used later by scripted messages).
- [ ] Miss rule edges: `now == nextFireAt` not missed; `paused` not missed; `lastFireAt == nextFireAt` not missed; `nextFireAt == 0` not missed.
- [ ] Catch-up edges: exactly 24 h → run; 24 h + 1 ms → no run, that instant in `missedFires`; three missed instants within 24 h → run the latest, the other two in `missedFires` with their original instants.
- [ ] One-shot missed > 24 h → no run, one entry in `missedFires`, next fire = 0 (ADR-017).
