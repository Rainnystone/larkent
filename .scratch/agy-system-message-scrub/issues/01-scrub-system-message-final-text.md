# 01: Scrub `<SYSTEM_MESSAGE>` from Antigravity `final_text`

**What to build:** any string that becomes Antigravity `final_text` (from `result.response` or held-back `agent_response` / `pendingText`) has balanced `<SYSTEM_MESSAGE>…</SYSTEM_MESSAGE>` envelopes removed before emit. Incident-shaped fixture: envelope + user prose → only user prose outbound. Clean replies unchanged.

**Blocked by:** None (can start immediately).

**Status:** ready

## Parent

[docs/specs/agy-system-message-scrub.md](../../../docs/specs/agy-system-message-scrub.md)

## What to build

Today `step_type=system_message` is silenced, but the same envelope can appear **inside** `agent_response` text deltas or `result.response`. `translateResult` / `prependHeldBack` push that string as `final_text`; channel sends it as the Feishu markdown body. `showToolCalls: false` does not strip body text.

After this ticket, scrub runs on both `final_text` emission paths. Multiple envelopes in one body are all removed. Unclosed opening tag strips through end of string. Empty-after-scrub follows existing empty SUCCESS / timeout-hint rules (do not invent a new hint). When scrub removes content, log once with before/after lengths (not the full body).

This ticket does **not** change channel.ts, CoT, or other agent translators unless extracting a tiny pure helper colocated with the antigravity translator is clearly cleaner — prefer local.

## Acceptance criteria

- [ ] Committed fixture (or inline objects) shaped like the 2026-09-18 incident: SUCCESS / agent_response text containing a `<SYSTEM_MESSAGE>…</SYSTEM_MESSAGE>` block prepended to user-facing Chinese prose → emitted `final_text` contains the prose and **no** `<SYSTEM_MESSAGE` substring.
- [ ] A clean SUCCESS with only user prose is unchanged.
- [ ] Envelope-only content yields no user-facing `final_text` from that content (empty path / existing hint rules).
- [ ] ERROR / FAILED mapping stays unchanged.
- [ ] Both `translateResult` and `prependHeldBack` paths are covered (or proven equivalent by shared scrub helper used by both).
- [ ] Scrub that removes content produces one structured log with lengths (no full envelope body).
- [ ] Tests at the translator seam; no live Feishu / agy required in CI.

## Blocked by

- None (can start immediately).
