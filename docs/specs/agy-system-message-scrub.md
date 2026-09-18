# Spec: Scrub Antigravity `<SYSTEM_MESSAGE>` envelopes from final Feishu replies

Status: ready-for-agent (docs track). Grill skipped — root cause locked from the 2026-09-18 哈基米 / cursor-agy incident. Do not reopen locked decisions.
Written 2026-09-18 from bridge log `kc3qieht`, Feishu outbound mget, and conversation DB step evidence.

This document is the destination. Tickets under `.scratch/agy-system-message-scrub/issues/` are disposable execution slices. Implementers claim tickets from the docs draft PR; they push product code only to a separate feat PR.

---

## Problem Statement

A Feishu user talking to an Antigravity (`agy`) profile can receive a **final reply that prepends an internal `<SYSTEM_MESSAGE>…</SYSTEM_MESSAGE>` envelope** (background task / tool-completion JSON, paths, identity blobs) before the real user-facing answer. The bot looks like it leaked system / tool process text. `showToolCalls: false` does not help, because the envelope arrived **inside** `agent_response` / `result.response` text, not as a tool block.

Official `step_type=system_message` lines are already silenced by the translator. The same content can still ride in response body text and be posted as markdown.

## Solution

Before any `final_text` is emitted from the Antigravity translator, strip known internal envelopes (at minimum `<SYSTEM_MESSAGE>…</SYSTEM_MESSAGE>`) from held-back `agent_response` text and from `result.response`. If scrubbing leaves only whitespace, treat as empty (existing empty / timeout-hint rules still apply). Log once when a scrub actually removed content, for operator observability.

Do **not** change agy, Feishu permissions, or `showToolCalls`. Do **not** map these envelopes into progress cards.

## Seams

Prefer existing seams. Do not invent a parallel filter bus.

1. **Translator seam (primary).** `AntigravityJsonlTranslator` already accumulates `pendingText` and chooses `result.response` vs pending text in `translateResult` / `prependHeldBack`. Scrub **immediately before** pushing `final_text`. Highest seam: one place, fixture-testable, no Feishu.

2. **Outbound seam (out of scope unless translator cannot cover).** `sendFinalReply` / `renderText` must not become the primary filter. Channel stays Feishu-facing; internals stay in the translator.

Ideal count: **one seam** (translator).

## User Stories

1. As a Feishu user on an antigravity profile, I want a turn whose model text includes a `<SYSTEM_MESSAGE>` task-completion envelope **plus** a real answer to post **only** the real answer, so I do not see tool JSON or internal envelopes.
2. As a Feishu user, I want a turn that is **only** a `<SYSTEM_MESSAGE>` envelope (no user-facing prose left after scrub) to behave like today's empty final text (skip-empty or existing timeout hint rules), so I am not spammed with stripped-noise leftovers.
3. As a Feishu user, I want a normal SUCCESS with clean `response` / `agent_response` and **no** envelope to stay byte-for-byte unchanged (aside from existing trim rules if any), so pong-style turns do not regress.
4. As a Feishu user, I want ERROR / FAILED results to keep posting the error path unchanged, so scrub does not swallow failures.
5. As a Feishu user with `showToolCalls: false` or `true`, I want the same scrub behavior, so preference flags are not a false safety net for body-embedded envelopes.
6. As a Feishu user in `final-answer` / markdown reply mode, I want scrub to apply to the single final blob, so `progress-stream-skipped` + one outbound still cannot leak envelopes.
7. As a Feishu user, I want multiple envelopes in one body (or envelope mid-text) to all be stripped, so partial scrub does not leave a second envelope.
8. As an operator reading bridge logs, I want a clear log when scrub removed content (counts or lengths), so incidents are diagnosable without re-fetching Feishu.
9. As an operator, I want official `step_type=system_message` lines to stay silently ignored (no new events), so this change does not reclassify already-known silent types.
10. As an operator, I want a committed fixture shaped like the 2026-09-18 incident (envelope +「收到！…」user reply → one `final_text` without the envelope), so Cloud CI regresses without live agy or Feishu.
11. As a dual-track implementer, I want to claim one ticket from the docs PR and push only to the clean feat PR, so scaffolding never lands on `master` via docs.

## Implementation Decisions

- **Scrub target:** strip balanced `<SYSTEM_MESSAGE>…</SYSTEM_MESSAGE>` blocks (case-sensitive tag as observed in agy output) from strings that become `final_text`. Nested or malformed closers: strip greedily from each opening tag through the matching closing tag when possible; if unclosed, strip from opening tag through end of string (safer than leaking).
- **Where:** apply to both `result.response` and `pendingText` paths that emit `final_text` (`translateResult` and `prependHeldBack`). Do not leave one path unfiltered.
- **After scrub:** trim surrounding whitespace. If empty, do not emit `final_text` from that content; fall through to existing empty SUCCESS / timeout-hint behavior.
- **Do not** strip arbitrary XML/HTML. Only the documented envelope tag(s) in this spec. If a second envelope family is later confirmed, extend via a follow-up ticket — do not invent a general HTML sanitizer here.
- **Telemetry:** when scrub removes non-empty content, log once at info/warn with before/after lengths (and optionally a short hash), not the full body (avoid re-leaking secrets into logs).
- **Parse-only continuity:** official `system_message` step types remain silent; this ticket is about **body text**, not step classification.
- **No channel / CoT / showToolCalls changes** for this spec.
- **No product code on the docs PR.** No copying `.scratch/` onto the feat branch.

## Testing Decisions

- Good tests assert observable translator output: input fixture → `AgentEvent[]` whose `final_text` has no `<SYSTEM_MESSAGE` and still contains the user-facing prose.
- Highest seam: `AntigravityJsonlTranslator` + JSONL / inline objects. No live Feishu, no live agy in CI.
- Fixtures: (a) incident-shaped SUCCESS with envelope prepended to「收到！…」; (b) clean SUCCESS unchanged; (c) envelope-only → no user prose `final_text` (empty path); (d) ERROR path unchanged.
- Prior art: existing antigravity-jsonl unit tests and fixtures from the #28 track.

## Out of Scope

- Changing agy Headless or how it surfaces background task completions.
- Feishu message edit/delete of already-sent leaks (ops, not product).
- General HTML/XML sanitization or prompt-injection defense beyond this envelope.
- Cursor / Claude / Codex / Grok translators (unless a shared helper is the cleanest extract — prefer antigravity-local first).
- Minutes-level host config (`printTimeout`, bridge restart).
- Merging this docs PR to `master` before the feat PR is reviewed.

## Further Notes

- Verified incident (Asia/Shanghai): 2026-09-18 ~20:26–20:30, 社交媒体运营 `oc_5cbe0c43947f08b7c17c81d28c31247b`, profile `cursor` / antigravity, trace `kc3qieht`, one outbound ~4410 chars (`om_x100b65e6a11b3cb4b10254b74b00974`). Envelope in conversation step ~452; user reply followed. Deployed tree was `1c222db` (#28) — parse/timeout fix did not cover body scrub.
- Dual-track: see `.scratch/agy-system-message-scrub/README.md`.
