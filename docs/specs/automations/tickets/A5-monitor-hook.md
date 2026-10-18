# A5: Monitor hook contract and local wake entry

> **Superseded in part:** status block 契约部分已被 [A19](A19-status-push-bridge.md) 取代（2026-10-18）；本机唤醒入口不变。

Spec: [../../automations.md](../../automations.md) §1 (miss rule, fire key), §4, §7, ADR-013/014/015

**What to build:** make the Larkent side of the larkent-monitor contract real and documented.
1. Operator docs for the status block v1 fields, the miss rule and the fire key format, as the single reference the private monitor follows. The monitor is a Cloudflare Worker scan → wake webhook → the always-on Grok Bot box; at most one wake per fire key; no GitHub Action; other PCs out of scope; no monitor code in this repo. Fixing larkent-monitor so misses stop happening is separate follow-up work outside this repo.
2. The **local wake entry**, defined here as a **new CLI subcommand** (next to `start` / `status` in src/cli/index.ts:167, :209) that takes a fire key. If Larkent is not running, it starts it and the startup catch-up applies. If it is running, it signals the running process to run the A0c wake path for that item. Already started → exits silently, sends nothing, reports to nobody. Idempotent and safe to repeat. There is **no stable IPC** to a running Larkent today: the UI server token is random per process (src/ui/server.ts:42-64), so this ticket picks and documents the transport (for example a wake-request file in the profile data dir that the scheduler consumes on startup and on change) and its cross-platform behaviour.
3. A contract test that reads the block text as another app would see it (simplified render keeps the note text) and applies the miss rule.

**Blocked by:** A0c, A4

**Status:** ready-for-agent

- [ ] Block read from the simplified render parses as v1; the miss rule on it matches Larkent's own decision for the same `now`.
- [ ] Wake for an already-started fire key → no message, no card update, only a local log line.
- [ ] Wake for a missed fire key ≤ 24 h → exactly one catch-up; a repeated wake for that key is silent.
- [ ] Larkent restarted on its own first, then the wake arrives → silent.
- [ ] Wake while Larkent is stopped → it starts and catches up once.
- [ ] Wake for a fire key > 24 h → no send; item shows 已错过 with the missed notice and log entry from A0c.
