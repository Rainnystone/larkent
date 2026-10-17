# A0a: Schedule pure functions

Spec: [../../automations.md](../../automations.md) §1, §2, §4 (miss rule), ADR-001/002/003/013

**What to build:** a pure module, no I/O, injected `now`: parse a structured schedule (one-shot; daily / weekday / weekly times; every N min/hour with optional `[from, to)` window incl. cross-midnight) with an IANA timezone; validate floors (reminder lead/interval ≥ 10 min, agent interval ≥ 1 h, one-shot ≤ 1 y ahead, recurring `endAt − startAt ≤ 1 y`, recurring requires `endAt`); compute next fire after an instant and the next 3 fires; compute "约每月 N 次"; the **miss rule** `isMissed(item, now)` and the **catch-up decision** `planCatchUp(item, now)` → `run(fireAt) | abandon(count) | none` (≤ 24 h, latest missed instant only, paused never); fire key formatting (`id@fireAt`).

**Blocked by:** None — can start immediately.

**Depends on #47:** none — pure functions, no Feishu, no delivery.

**Status:** ready-for-agent

- [ ] Table tests run in a UTC host: weekday skips Sat/Sun; window 22:00–02:00 belongs to the start day; DST gap shifts to the next valid minute; DST overlap fires once.
- [ ] Floors and 1-year caps reject with a typed reason (used later by scripted messages).
- [ ] Miss rule edges: `now == nextFireAt` not missed; `paused` not missed; `lastFireAt == nextFireAt` not missed; `nextFireAt == 0` not missed.
- [ ] Catch-up edges: exactly 24 h → run; 24 h + 1 ms → abandon; three missed instants within 24 h → run the latest, count 2 missed.
