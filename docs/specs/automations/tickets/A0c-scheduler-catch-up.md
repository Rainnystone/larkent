# A0c: Scheduler, fake clock, fire-key idempotency, catch-up ≤ 24 h

Spec: [../../automations.md](../../automations.md) §4, §7 (local wake entry), ADR-006/011/013/016/017/019

**What to build:** the profile-owned scheduler driven by an injected clock and timer; fires at `nextFireAt`; persists the fire key as started (and `lastFireAt` = scheduled instant) **before** calling the sender; the sender is an **injected interface** (`FireSender`) so this ticket needs no Feishu delivery. Runs the catch-up rule from A0a on three triggers with identical behaviour: startup, an injected "link recovered" signal, and an injected **wake** call (given a fire key: already started → silent no-op with only a local log line; otherwise apply the catch-up rule). Catch-up fires carry the original scheduled time so the sender can render "补跑，原定 HH:MM", and write a catch-up entry to the automations log. Every missed instant (not caught up) increments `missed`, is recorded for the board's 已错过 rows, is handed to an injected **missed notifier** (one chat notice per item per catch-up pass, listing each original time) and gets an automations log entry. One-shot not caught up → `nextFireAt = 0`, removed 24 h later as expiry. Writes the local status file (`updatedAt`, items with `id`, `paused`, `nextFireAt`, `lastFireAt`, `lastStatus`, `endAt`, `missed`) atomically on every change. Fires bypass the process pool and are never queued; overlap allowed.

The real wake transport is **not** in this ticket: it is deferred entirely to A5. The UI server can't carry it: its token is random per process (`randomBytes(32)` in `startUiServer`, src/ui/server.ts:42-64, token at :49).

**Blocked by:** A0a, A0b

**Status:** ready-for-agent

- [ ] Fake clock reaches the instant → sender called exactly once; nothing before it.
- [ ] Clock jumps 3 instants of an every-hour item while "stopped", then restart → one catch-up for the latest instant with its original time; missed = 2; the notifier gets one call listing both original times; the automations log has 2 missed + 1 catch-up entries.
- [ ] Missed instant 25 h old → no send, missed +1, `lastStatus = missed`, `nextFireAt` advanced, notifier + log called.
- [ ] One-shot missed 25 h → `nextFireAt = 0`, shown missed, deleted 24 h later; its log entry remains.
- [ ] Restart, link-recovered and wake for the same fire key, in every order and concurrently → sender called once; the later ones are silent.
- [ ] Kill between "started persisted" and sender call → restart does not resend (delivery recovery is the Outbox's job in A1').
- [ ] Paused item is never caught up; resume recomputes from now.
- [ ] Status file matches the store after fire, catch-up, abandon, pause, delete.
