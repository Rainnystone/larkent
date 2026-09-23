# Spec: Cursor assistant CoT hold-back (align with Grok)

Status: ready-for-agent (docs track). Grill closed by product owner (locked 2026-09-23). Do not reopen locked decisions.
Written 2026-09-23 from Feishu bot「Fable」/ profile `cursor-claude` regressions after switching to Opus 5.5 High: private-chat English「思考/计划」segments interleaved in replies (systematic).

This document is the destination. Tickets under `.scratch/cursor-assistant-cot-holdback/issues/` are disposable execution slices. Implementers claim tickets from the docs draft PR; they push product code only to a separate feat PR.

---

## Problem Statement

Owner intent: Feishu users on Cursor profiles must **not** see pre-tool English plan / thinking monologues that ride inside assistant **body text**. Protocol `thinking` events are already dropped; the leak is elsewhere.

### Symptom

After Opus 5.5 High (`effort=high`), private messages under Fable / `cursor-claude` systematically show English thinking / planning prose mixed into the Feishu reply stream (markdown progress-stream forwards `text` deltas as-is).

### Mechanism (locked)

1. Cursor CLI protocol `thinking` events are already discarded in `CursorJsonlTranslator` (`case 'thinking': return []`). That path is **not** the leak.
2. Leak source is assistant **body text**:
   - `queueAssistantText` flushes the previous pending segment as a `text` delta when a new assistant segment arrives.
   - `prependPendingText` flushes pending as a `text` delta **before** `tool_call` events.
3. Those intermediate `text` deltas reach Feishu via the markdown progress-stream unchanged → users see tool-front English plans.
4. **Grok path is the reference correctly**: `thought` discarded; on `tool_call` **clear** `pendingText` (do **not** flush pre-tool monologue); body text held until `final_text` on end. See comments in `src/agent/grok/jsonl.ts`.
5. CLI: keep `effort=high`. **Forbidden** to “fix” the leak with `thinking:false`. Do **not** touch `~/.cursor/cli-config.json`.

### What exists today (must change)

`src/agent/cursor/jsonl.ts` currently documents and implements:

> Intermediate assistant texts are forwarded as `text` deltas; the last one is held back as `final_text`.

Unit test `streams intermediate assistant messages as text deltas` locks that leak behavior (`Let me check.` emitted as `text` before tool_use). **This Spec rewrites that decision and that test.**

---

## Solution

Align `CursorJsonlTranslator` hold-back with Grok:

- Do **not** emit intermediate assistant segments as bridge `text` events destined for Feishu.
- On `tool_call`: **discard / clear** pending assistant text (do **not** `prependPendingText` flush).
- On `result` / `finish` (success paths): emit the last pending segment (or a reasonable merge of the final answer segment only) as `final_text`.
- Keep discarding protocol `thinking` events.
- Keep ignoring `result.result` as reply body (concatenated junk; already correct).

Scope is the Cursor JSONL translator and its unit tests only. No CLI default changes, no effort toggle, no fragile English CoT regex classifier, no channel / keepalive / other-agent translators.

---

## Seams

Prefer the existing Cursor translator seam. Do not invent a parallel filter bus.

1. **Translator seam (primary / only load-bearing).** `CursorJsonlTranslator` in `src/agent/cursor/jsonl.ts`:
   - Change `queueAssistantText` so it does **not** emit prior pending as `text` deltas.
   - Change `tool_call` handling so pending is cleared/discarded instead of `prependPendingText`.
   - Keep `finish` / `translateResult` emitting `final_text` from the last held segment on success paths.
2. **Unit tests.** `tests/unit/agent/cursor-jsonl.test.ts` — rewrite the intermediate-stream test; add Opus-shaped multi-segment + tool fixture(s).
3. **Out of scope seams.** `channel.ts`, keepalive, Feishu outbound, CLI argv / `cli-config.json`, CoT regex, Antigravity / Claude / Codex / Grok translators (Grok already correct — reference only).

Ideal count: **one** load-bearing seam (Cursor translator + tests).

---

## User Stories

1. As a Feishu user on `cursor-claude` / Opus 5.5 High, I want pre-tool English plan monologues **not** to appear in the progress stream or final reply, so I only see the real answer.
2. As a Feishu user, I still want the final user-visible answer delivered as `final_text` after tools complete.
3. As a Feishu user, I want protocol `thinking` events to remain silent (already true; must stay true).
4. As an operator, I want `effort=high` retained; I do **not** want `thinking:false` or edits to `~/.cursor/cli-config.json` as the “fix.”
5. As a dual-track implementer, I want one tracer ticket with red fixtures then green implementation (+ `pnpm ci:local`), claimed on the docs PR and pushed only to the feat PR.

---

## Implementation Decisions

Locked 2026-09-23. Do not Grill.

**D1 — Align with Grok hold-back.** Intermediate assistant body segments are **not** streamed as bridge `text`. Hold pending; emit user-facing answer only as `final_text` on finish/result success paths.

**D2 — Tool-call clears pending.** On `tool_call`, discard/clear pending assistant text. Do **not** prepend-flush it as `text`. Pre-tool CoT/plan monologue must not reach Feishu.

**D3 — Final answer preserved.** After the last tool round, the last assistant segment (the real answer) is still emitted as `final_text`. Do not drop the user-visible answer. `result.result` remains unused as reply body.

**D4 — Protocol `thinking` stays dropped.** `case 'thinking': return []` unchanged; not counted as protocol drift.

**D5 — No CLI / effort / thinking:false fix.** Keep `effort=high`. Forbidden: `thinking:false`, edits to `~/.cursor/cli-config.json`, or any “turn off thinking” workaround.

**D6 — No English CoT regex classifier.** Do not classify / strip English plan prose by fragile regex. Fix is hold-back semantics, not content sniffing.

**D7 — Scope = Cursor translator + unit tests.** No `channel.ts` / keepalive / other adapters. No Spec/scratch files on the code PR.

**D8 — Rewrite the locking test.** Replace `streams intermediate assistant messages as text deltas` with expectations that tool-front assistant text is **not** emitted as `text`; `final_text` remains the post-tool answer. Add multi-segment + multi-tool fixture coverage in the same ticket if needed.

**D9 — Failed / interrupted finish.** On `finish('failed')` / `fail(...)`, do **not** resurrect discarded pre-tool pending as user-visible `text` (prefer clear-on-tool semantics consistent with D2). Exact error/done shape may follow existing Grok/Cursor error paths as long as CoT does not leak.

**D10 — Delivery shape.** One tracer ticket: (1) red tests/fixtures (2) green translator change + `pnpm ci:local`. No second ticket unless a later residual appears; boundaries (multi-round tools, duplicate identical assistant text, finish failed) are acceptance rows on ticket 01.

---

## Non-goals

- Turning off Cursor CLI thinking / lowering effort / editing `cli-config.json`.
- Regex or ML classification of “this English paragraph is CoT.”
- Changing Feishu channel / progress-stream / markdown renderer.
- Porting this Spec to Claude / Codex / Antigravity in the same change (separate Specs if needed).
- Touching `src/bot/channel.ts` or `src/bot/keepalive.ts` (unrelated dirty local work).

---

## Acceptance Criteria (Spec-level)

- [ ] Opus-shaped fixture: multiple assistant text segments + at least one tool_call → **no** bridge `text` event carrying the pre-tool plan monologue.
- [ ] Same fixture → post-tool final answer still arrives as `final_text`.
- [ ] Protocol `thinking` lines still produce no events and no drift.
- [ ] Existing “do not use `result.result` as body” behavior preserved.
- [ ] Multi-round tools: pending cleared each tool_call; only last post-tool answer (or held final segment) is `final_text`.
- [ ] Duplicate identical assistant segments still no-op / no spurious `text` (preserve current dedupe intent where applicable).
- [ ] `finish('failed')` / error paths do not flush discarded pre-tool CoT as `text`.
- [ ] No CLI config / effort / `thinking:false` changes.
- [ ] Code PR has red-then-green commits; `pnpm ci:local` green; no `.scratch/` or Spec on code PR.

---

## Tickets

| # | Title | Blocked by |
| --- | --- | --- |
| 01 | Cursor hold-back tracer (`CursorJsonlTranslator` + unit tests) | None |

One tracer is enough: seam + fixtures cover the locked product change. No second ticket at open.

---

## Dual-track

- **Docs (this):** Spec + tickets + delivery-note placeholders only. Do not merge as product.
- **Code:** separate `feat/cursor-assistant-cot-holdback` — implementers claim 01 here and push only there.
