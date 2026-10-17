# A5: Monitor hook contract and local wake entry

Spec: [../../automations.md](../../automations.md) §1 (miss rule, fire key), §4, §7, ADR-013/014/015

**What to build:** make the Larkent side of the larkent-monitor contract real and documented. (1) Operator docs for the status block v1 fields, the miss rule and the fire key format, as the single reference the private monitor follows (monitor = Cloudflare Worker scan → wake webhook → always-on Grok Bot box; at most one wake per fire key; no GitHub Action; other PCs out of scope; no monitor code in this repo). (2) The **local wake entry** the woken box calls with a fire key: already started → exits silently, sends nothing, reports to nobody; Larkent not running → start it, then the startup catch-up applies; running → trigger the A0c catch-up for that item. Idempotent and safe to repeat. (3) A contract test that reads the block text as another app would see it (simplified render keeps the note text) and applies the miss rule.

**Blocked by:** A0c, A4

**Depends on #47:** none — the entry triggers the scheduler; real delivery comes from A1'. The wake → reminder path is covered end to end in A11.

**Status:** ready-for-agent

- [ ] Block read from the simplified render parses as v1; the miss rule on it matches Larkent's own decision for the same `now`.
- [ ] Wake for an already-started fire key → no message, no card update, only a local log line.
- [ ] Wake for a missed fire key ≤ 24 h → exactly one catch-up; a repeated wake for that key is silent.
- [ ] Larkent restarted on its own first, then the wake arrives → silent.
- [ ] Wake for a fire key > 24 h → no send; item shows missed.
