# 02: Timeout hint on empty SUCCESS after print-timeout

**What to build:** when agy ends a print-mode turn with SUCCESS and an empty `response` because print-timeout fired (incident: tools + checkpoint, no `agent_response`, default five-minute ceiling), the bridge must **not** treat that as a clean empty finish. The translator (or, only if required, the outbound boundary) emits a timeout hint so `renderText` is non-empty and outbound does not `skip-empty` / mute the chat.

**Blocked by:** 01 (the incident fixture includes official `tool` / `checkpoint` lines; those must already be known protocol so this ticket does not re-introduce `unknown_event`, and the heuristic may use "this run saw a tool or checkpoint").

**Status:** ready-for-agent

## Parent

[docs/specs/agy-jsonl-compat.md](../../../docs/specs/agy-jsonl-compat.md) — section (b) timeout / empty-success mute fix.

## What to build

Today an empty SUCCESS `result` with no held-back `agent_response` text emits `done(normal)` and no body. Outbound then logs `skip-empty` and posts nothing. Print-timeout is the case where that silence is a lie.

Classify empty SUCCESS per the Spec:

1. First-class timeout / reason / error field on the `result` envelope if the captured official payload has one. Do not invent a field.
2. Else the incident heuristic: SUCCESS, empty/missing `response`, no held-back `agent_response` text, and this run already saw a recognized `tool` or `checkpoint` → timeout hint.
3. Else keep the clean empty finish (no hint).

The hint must survive antigravity's `final-answer` projection. Prefer `final_text` or a shown `error` message — events the existing reducer already renders as non-empty. Do **not** reuse `terminationReason: 'timeout'` if that would print the bridge idle-watchdog sentence ("N 分钟无响应"). Touch channel only if those events cannot carry a distinct print-timeout hint.

Preserve the resume handle. Keep ERROR / FAILED mapping. Keep a SUCCESS that has real `response` or held-back text. This ticket does **not** add `--print-timeout` config and does **not** start Feishu tool cards.

## Acceptance criteria

- [ ] Incident-shaped fixture (`init`, many `tool`, one `checkpoint`, no `agent_response` text, SUCCESS with empty/missing `response`) emits a timeout hint event and does **not** emit a bare `done(normal)` with no body.
- [ ] After reducing those events with the existing run-state reducer, `renderText` (or the same emptiness check outbound uses) is non-empty. The notice is about print-timeout / no reply, not the idle-watchdog copy.
- [ ] A short clean empty SUCCESS (no `tool` / `checkpoint`, no `agent_response` text, no timeout field) still has no hint, so today's `skip-empty` remains valid.
- [ ] SUCCESS with a non-empty `response`, or empty `response` plus held-back `agent_response` `text_delta`, still posts that text and is not classified as print-timeout.
- [ ] ERROR / FAILED results still become terminal `error` (no timeout-hint substitution).
- [ ] Resume handle from `init` / `result.conversation_id` is still emitted on the timeout-classified path.
- [ ] Official `tool` / `checkpoint` lines in the incident fixture do not increment `unknownEvents` (relies on 01).
- [ ] Cloud tests use fixtures at the translator seam (plus reducer/`renderText` if needed). Live stream-json is local evidence only.

## Blocked by

- [01: Recognize official `tool` and `checkpoint` steps (parse only)](01-recognize-tool-checkpoint.md)
