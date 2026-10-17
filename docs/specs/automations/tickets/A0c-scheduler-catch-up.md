# A0c: Scheduler, fake clock, fire-key idempotency, catch-up ≤ 24 h

Spec: [../../automations.md](../../automations.md) §4, §7 (local wake entry), ADR-006/011/013

**What to build:** the profile-owned scheduler driven by an injected clock and timer; fires at `nextFireAt`; persists the fire key as started (and `lastFireAt` = scheduled instant) **before** calling the sender; the sender is an **injected interface** (`FireSender`) so this ticket needs no Feishu delivery. Runs the catch-up rule from A0a on three triggers with identical behaviour: startup, an injected "link recovered" signal, and the **local wake entry** (given a fire key: already started → silent no-op with only a local log line; otherwise apply the catch-up rule). Catch-up fires carry the original scheduled time so the sender can render "原定 HH:mm". Writes the local status file (`updatedAt`, items with `id`, `paused`, `nextFireAt`, `lastFireAt`, `lastStatus`, `endAt`, `missed`) atomically on every change. Fires bypass the process pool and are never queued; overlap allowed.

**Blocked by:** A0a, A0b

**Depends on #47:** none — the sender and the link-recovered signal are injected; A1' wires the real ones.

**Status:** ready-for-agent

- [ ] Fake clock reaches the instant → sender called exactly once; nothing before it.
- [ ] Clock jumps 3 instants of an every-hour item while "stopped", then restart → one catch-up for the latest instant with its original time, missed = 2.
- [ ] Missed instant 25 h old → no send, missed +1, `lastStatus = missed`, `nextFireAt` advanced.
- [ ] Restart, link-recovered and wake entry for the same fire key, in every order and concurrently → sender called once; the later ones are silent.
- [ ] Kill between "started persisted" and sender call → restart does not resend (delivery recovery is the Outbox's job in A1').
- [ ] Paused item is never caught up; resume recomputes from now.
- [ ] Status file matches the store after fire, catch-up, abandon, pause, delete.
