# 01: Cursor assistant CoT hold-back tracer

**What to build:** change `CursorJsonlTranslator` so intermediate assistant body text is **held**, not streamed as `text`; on `tool_call` **clear/discard** pending (do not `prependPendingText`); emit only the final held segment as `final_text` on success finish/result. Prove with unit tests (rewrite the locking intermediate-stream test; add Opus multi-segment + tool fixture).

**Blocked by:** None

**Status:** ready-for-agent

## Parent

[docs/specs/cursor-assistant-cot-holdback.md](../../../docs/specs/cursor-assistant-cot-holdback.md) — D1–D10; Problem Statement mechanism; Acceptance Criteria.

## What to build

Today (`src/agent/cursor/jsonl.ts`):

- `queueAssistantText` emits prior `pendingAssistantText` as `{ type: 'text', delta: pending + '\n\n' }` when a new assistant segment arrives.
- `tool_call` goes through `prependPendingText`, which flushes pending as `text` before `tool_use` / `tool_result`.
- Protocol `thinking` is already `return []` (keep).
- Last pending becomes `final_text` on `finish('normal')` / success `result` (keep the final-answer path; change only what gets flushed early).

Grok reference (`src/agent/grok/jsonl.ts`): `thought` dropped; `tool_call` sets `pendingText = ''`; text concatenated and held for `final_text`. Align Cursor to that semantics for **assistant body** hold-back (Cursor still has discrete assistant messages rather than incremental chunks — hold the current pending segment; on new assistant without tools, replace/hold without emitting `text`; on tool_call, clear).

Tests (`tests/unit/agent/cursor-jsonl.test.ts`):

- **Rewrite** `streams intermediate assistant messages as text deltas` so `Let me check.` is **not** present as a `text` delta before tool_use; `final_text` remains `Done.` (or equivalent).
- Add / extend an Opus-shaped multi-assistant-segment + tool fixture that would previously leak English plan prose.
- Keep: `thinking` ignored, no drift; `result.result` not used as body; plain no-tool run still `final_text`.
- Cover boundaries in the same ticket: multi-round tools (clear each time); duplicate identical assistant text no spurious `text`; `finish('failed')` does not resurrect discarded pre-tool pending as `text`.

Do **not**: set `thinking:false`, change effort, edit `cli-config.json`, add English CoT regex, touch `channel.ts` / keepalive / other agents.

Delivery shape: prefer two commits on the code PR — (1) red tests (2) green translator + `pnpm ci:local`. One commit acceptable if review still shows red-then-green locally in the delivery note.

## Acceptance criteria

- [ ] Fixture: assistant plan text → tool_call started/completed → assistant final answer → success result → events contain **no** `text` delta with the plan; contain `final_text` with the final answer; tool_use/tool_result still present.
- [ ] Existing intermediate-stream test rewritten to lock hold-back (no longer expects `Let me check.\n\n` as `text`).
- [ ] Protocol `thinking` still silent, drift unchanged.
- [ ] `result.result` still not used as reply body.
- [ ] Multi-round tools: pre-tool pending cleared; only last answer as `final_text`.
- [ ] Duplicate identical assistant segment does not emit `text`.
- [ ] `finish('failed')` / `fail` path does not flush discarded pre-tool CoT as `text`.
- [ ] No CLI / config / other-file scope creep.
- [ ] `pnpm ci:local` green on the code PR; delivery note filled; no Spec/scratch on code PR.

## Blocked by

- None (can start immediately).
