# Spec: Antigravity envelope scrub v2 (classifier + `<task_notification>`)

Status: ready-for-agent (docs track). Grill closed by product owner (Fable Grill + private-chat verification 2026-09-18). Do not reopen locked decisions.
Written 2026-09-18 from Incident A leak, Incident B over-scrub, and post-22:24 哈基米 private-chat evidence. **Supersedes** the #30 unclosed / nesting policy in `docs/specs/agy-system-message-scrub.md` (merged via PR #30 @ `dea83e0` / `b1b9617`).

This document is the destination. Tickets under `.scratch/agy-envelope-scrub-v2/issues/` are disposable execution slices. Implementers claim tickets from the docs draft PR; they push product code only to a separate feat PR.

---

## Problem Statement

Owner intent: **never** post tool/internal envelopes as a Feishu final reply; **never** mutilate prose that merely cites the tag. Fix is a **classifier**, not character truncation.

### Incident A — leak (why #30 existed)

On 2026-09-18 ~20:26–20:30 Asia/Shanghai, 社媒群 traffic under antigravity profile posted a ~4410-char outbound whose body still contained a `<SYSTEM_MESSAGE>…</SYSTEM_MESSAGE>` envelope (background / tool-completion JSON) before user-facing prose. Trace `kc3qieht`. Outbound message id `om_x100b65e6a11b3cb4b10254b74b00974`. Official `step_type=system_message` lines were already silent; the envelope rode **inside** `agent_response` / `result.response` text. PR #30 shipped a translator scrub.

### Incident B — over-scrub (why #30 is wrong)

On 2026-09-18 ~22:20–22:22 Asia/Shanghai, p2p 哈基米 chat `oc_7aa4b17e9957493f4a0746158d2aab2e` logged `system_message_scrubbed` with cuts **415→190** and **864→469**. DB-confirmed: an inline `` `<SYSTEM_MESSAGE>` `` citation inside prose / blockquote was treated as an **unclosed opener**, and #30's policy peeled from that token **through end of string**. Message `om_x100b65e0c7d5dca8b18a145fcdaa1ae` was later edited in Feishu (edit lengths can diverge from bridge outbound — diagnose from logs + conversation DB, not Feishu alone).

A larger cut **~20885→259** was observed on the same mechanism when tool / test failure text contained an unclosed `<SYSTEM_MESSAGE>` substring (e.g. a vitest test **title** mentioning the tag).

### Post-22:24 private-chat verification (same night)

1. **22:27 CST** — scrub **20885→259**: body was a `<task_notification>…` blob plus a vitest failure whose test title contained unclosed `<SYSTEM_MESSAGE>` (`scrubs multi-line and nested <SYSTEM_MESSAGE> blocks…`). #30 peeled from the title tag through end; Feishu received only ~259 chars ending at `nested`.
2. **`<task_notification>` is envelope family #2.** #30 does **not** strip it; Feishu still received that prefix. This Spec adds scrub/quarantine for `<task_notification>` (balanced / fingerprinted-unclosed rules analogous to SYSTEM_MESSAGE).
3. **22:34 “worked”** only because the model wrote `【SYSTEM_MESSAGE】` (fullwidth brackets) — **evasion, not a fix**. Residual risk: lookalike / fullwidth / zero-width variants are out of scope for v2.
4. Feishu `messages-edit` can diverge from bridge outbound lengths — use logs + DB for diagnosis.
5. A proposal to “always keep unclosed” is **REJECTED**. Keep **D4**: unclosed strip-through-end **only if fingerprinted**.

### What #30 locked that this Spec supersedes

The #30 Spec said: if unclosed, strip from opening tag through end of string. The unit test `strips every envelope in one body including an unclosed opener` locked that expectation. **This Spec rewrites that decision and that test.** Nesting depth matching is also rejected (depth + preamble bare tag wiped whole replies).

---

## Solution

Replace the #30 greedy / depth-matching scrub with a **positional + code-context + fingerprint classifier** for `<SYSTEM_MESSAGE>`, applied at the same Antigravity translator seam. Extract a pure module (e.g. `src/agent/antigravity/envelopes.ts`) shared by both `translateResult` and `prependHeldBack` final_text paths.

Also scrub **`<task_notification>`** as envelope family #2 (same seam, same pure module), so tool/test blobs prefixed with task notifications cannot ride into Feishu.

Telemetry keeps scrubbed lengths and adds classifier outcomes; when a literal tag is **retained**, log a structured reason without the body.

Optional, non-load-bearing: one `BRIDGE_SYSTEM_PROMPT` line asking the model not to echo injected SYSTEM_MESSAGE task notices — defense in depth only, not primary.

---

## Seams

Prefer existing seams. Do not invent a parallel filter bus.

1. **Translator seam (primary).** `AntigravityJsonlTranslator` already chooses `result.response` vs held-back `pendingText` in `translateResult` / `prependHeldBack` and emits via `emitScrubbedFinalText`. Keep scrub **immediately before** pushing `final_text`. Extract pure helpers into `src/agent/antigravity/envelopes.ts` (or equivalent) so classifier + multi-family rules are unit-testable without the full translator.

2. **Prompt seam (optional, non-primary).** `BRIDGE_SYSTEM_PROMPT` may gain one line: do not echo injected `<SYSTEM_MESSAGE>` task notices. Not a substitute for the classifier.

3. **Outbound / channel seam (out of scope).** `sendFinalReply` / `channel.ts` must not become the primary filter. No CoT / other-agent translators in this Spec.

Ideal count: **one load-bearing seam** (antigravity translator + pure envelopes module). Prompt is optional garnish.

---

## User Stories

1. As a Feishu user on an antigravity profile, I want a real `<SYSTEM_MESSAGE>` task envelope (fingerprinted or balanced) stripped from the final reply, so I never see tool JSON / internal envelopes as the answer.
2. As a Feishu user, I want prose that **cites** `` `<SYSTEM_MESSAGE>` `` mid-line, in a list, in a blockquote, or inside markdown code / fences to stay byte-identical for that citation, so Incident B cannot recur.
3. As a Feishu user, I want an unclosed `<SYSTEM_MESSAGE>` that is **not** fingerprinted to leave the whole string byte-identical, so a vitest title or error snippet mentioning the tag cannot peel away the rest of the answer.
4. As a Feishu user, I want an unclosed but **fingerprinted** envelope to strip through end, so a truncated real envelope still cannot leak.
5. As a Feishu user, I want a preceding preamble line (`The following is a <SYSTEM_MESSAGE> not actually sent by the user…`) removed together with the envelope it introduces, so scrub does not leave orphan preamble.
6. As a Feishu user, I want `<task_notification>…` (family #2) stripped so a vitest / tool blob prefixed with task notification cannot become the Feishu body.
7. As a Feishu user, I want empty-after-scrub to follow existing empty SUCCESS / timeout-hint rules, and ERROR / FAILED mapping untouched.
8. As a Feishu user, I want a stray closer alone left alone, and case-sensitive exact tags only.
9. As an operator, I want logs that keep before/after lengths and add removed count, unclosed bool, preambleRemoved, sawSystemMessageStep — never the body.
10. As an operator, I want `jsonl.system_message_tag_retained` (or equivalent) with reasons `mid-line` / `code-span` / `fence` / `unclosed-no-fingerprint` when a literal open tag is seen but not stripped.
11. As a dual-track implementer, I want one primary ticket with red fixtures then green implementation (+ `pnpm ci:local`), and optionally a second ticket for `task_notification` blocked on the classifier module landing.
12. As a dual-track implementer, I want to claim from the docs PR and push only to the clean feat PR, so scaffolding never lands on `master` via docs.

---

## Implementation Decisions

Locked from Fable Grill; supersede #30 unclosed / nesting policy. Owner intent: never post tool/internal envelopes as Feishu final reply; never mutilate prose that cites the tag; **NOT** char truncation.

**D1 — Opener candidacy is positional.** `<SYSTEM_MESSAGE>` is an envelope-opener **candidate** only at line start (whitespace-only before it on the line, or string position 0). Mid-line / list / blockquote mid-content = prose, untouched.

**D2 — Markdown code context = citation.** Odd backtick count earlier on the same line (inline code) **OR** odd fence-line count in the output so far → not an envelope (retain).

**D3 — Fingerprint.** After the tag, within ~64 chars, match `^\s*\[Message\]\s+(timestamp|sender|priority|content)=` **OR** the preceding line is the preamble `The following is a <SYSTEM_MESSAGE> not actually sent by the user…`. Keep a small **table of shapes** in the pure module (or adjacent fixture doc) so future envelope rows can extend without reopening grill.

**D4 — Unclosed.** If a matching closer appears later → strip the block (**fingerprint not required** for balanced pairs). If no closer: strip-through-end **only if fingerprinted**; else leave **byte-identical**. Never strip only the open token.

**D5 — No nesting depth matcher.** First closer wins. (Depth matching + preamble bare tag wiped whole replies under #30.)

**D6 — Preamble companion.** When stripping an envelope, also remove the immediately preceding preamble line if present.

**D7 — Post-strip.** Trim; empty → existing empty SUCCESS / timeout-hint; ERROR untouched; case-sensitive exact tags; stray closer alone left alone.

**D8 — Seam.** Antigravity translator on both `translateResult` and `prependHeldBack` final_text paths. Extract pure module e.g. `src/agent/antigravity/envelopes.ts`. No channel / CoT / other translators.

**D9 — Telemetry.** Keep scrubbed lengths; add removed count, unclosed bool, preambleRemoved, sawSystemMessageStep; add `jsonl.system_message_tag_retained` with reasons (`mid-line` / `code-span` / `fence` / `unclosed-no-fingerprint`). Never log body.

**D10 — Optional prompt line.** One `BRIDGE_SYSTEM_PROMPT` line not to echo injected SYSTEM_MESSAGE task notices — not primary defense.

**D11 — Delivery shape.** Primary ticket: two commits on the code PR — (1) fixtures/tests red (2) implementation green + `pnpm ci:local`.

**D12 — Fixture matrix + rewrite #30 test.** Matrix A1–A4, B1–B5, C1–C3, T1 below. Rewrite the #30 unclosed test expectation to match D4. A2 from real Incident A payload when available (cite message id `om_x100b65e6a11b3cb4b10254b74b00974`).

**D13 — Envelope family #2: `<task_notification>`.** Scrub/quarantine balanced `<task_notification>…</task_notification>` (and fingerprinted-unclosed analog if a fingerprint is confirmed; until then, balanced strip + positional opener rules). Must not treat a bare mention inside a vitest title as a SYSTEM_MESSAGE peel. Fixture: `task_notification` + vitest failure line whose test **name** contains `<SYSTEM_MESSAGE>` + trailing Chinese answer → keep the answer; drop the task_notification envelope; do **not** peel-to-end from the title citation.

### Rejected (do not reopen)

- Character cap / truncation as the primary fix
- Strip-through-end for **any** unclosed opener (the #30 policy)
- Strip-only-token (leave body after open tag)
- Nesting depth matcher
- General HTML/XML sanitizer
- Channel-layer primary filter
- Rely on prompt alone
- “Always keep unclosed” (Hakimi proposal) — rejected; keep D4

---

## Fixture matrix

Commit fixtures (JSONL and/or inline objects) at the translator / pure-module seam. Names are normative for the ticket board.

| ID | Intent | Expectation |
| --- | --- | --- |
| **A1** | Balanced `<SYSTEM_MESSAGE>` with `[Message]` fingerprint + user prose | Strip envelope; keep prose |
| **A2** | Real Incident A payload (when available; cite `om_x100b65e6a11b3cb4b10254b74b00974`) | Strip envelope; keep user-facing answer |
| **A3** | Unclosed opener **with** fingerprint | Strip-through-end; no leak |
| **A4** | Preamble line + balanced envelope + prose | Remove preamble + envelope; keep prose |
| **B1** | Mid-line / list / blockquote mid-content `<SYSTEM_MESSAGE>` | Retain; byte-identical citation region |
| **B2** | Inline code `` `<SYSTEM_MESSAGE>` `` (odd backtick on line) | Retain (`code-span`) |
| **B3** | Tag inside fenced code block (odd fence count) | Retain (`fence`) |
| **B4** | Unclosed opener, **no** fingerprint (e.g. vitest title) | Leave **byte-identical** whole string |
| **B5** | Stray `</SYSTEM_MESSAGE>` alone | Leave alone |
| **C1** | Nested-looking opens | First closer wins; no depth matcher |
| **C2** | Envelope-only → empty after scrub | Existing empty SUCCESS / timeout-hint path |
| **C3** | ERROR / FAILED mentioning the tag | Mapping untouched |
| **T1** | Telemetry | Lengths + removed count + unclosed + preambleRemoved + sawSystemMessageStep; retained reasons when applicable; never body |
| **TN1** | `<task_notification>` + vitest line with `<SYSTEM_MESSAGE>` in test name + trailing Chinese answer | Drop task_notification; do not peel from title citation; keep Chinese answer |

Rewrite #30 test `strips every envelope in one body including an unclosed opener` so an unclosed **non-fingerprinted** tail is retained (B4), not peeled.

---

## Testing Decisions

- Good tests assert observable output: fixture → scrubbed string / `AgentEvent[]` whose `final_text` matches the matrix row.
- Highest seam: pure `envelopes.ts` unit tests **plus** translator integration covering both `translateResult` and `prependHeldBack`.
- No live Feishu / agy in CI. Incident A raw payload is optional local evidence; if not embeddable, A2 may be a redacted shape citing the message id.
- `pnpm ci:local` green on the implementation commit.

---

## Out of Scope

- Changing agy Headless emission of envelopes / task notifications.
- Feishu message edit/delete of already-sent leaks (ops).
- Fullwidth / lookalike / zero-width tag variants (`【SYSTEM_MESSAGE】`, etc.) — document as residual risk only.
- General HTML sanitizer; prompt-injection defense beyond optional D10 line.
- Cursor / Claude / Codex / Grok translators.
- Channel.ts / keepalive / CoT changes.
- Merging this docs PR to `master` before the feat PR is reviewed.
- Implementing product code on the docs branch.

---

## Further Notes

- Incident A (Asia/Shanghai): 2026-09-18 ~20:26–20:30, 社媒群, trace `kc3qieht`, ~4410-char outbound with envelope in body; message `om_x100b65e6a11b3cb4b10254b74b00974`. #30 attempted fix on tree after #28.
- Incident B (Asia/Shanghai): 2026-09-18 ~22:20–22:22, p2p 哈基米 `oc_7aa4b17e9957493f4a0746158d2aab2e`; logs `system_message_scrubbed` 415→190 and 864→469; later edit on `om_x100b65e0c7d5dca8b18a145fcdaa1ae`.
- Larger cut ~20885→259 (22:27): `<task_notification>` prefix + vitest failure title containing unclosed `<SYSTEM_MESSAGE>` — same #30 peel-to-end.
- Dual-track board: `.scratch/agy-envelope-scrub-v2/README.md`.
- Prior Spec (historical): `docs/specs/agy-system-message-scrub.md` on docs PR #29 — policy superseded here; do not re-litigate on that branch.
