# 01: Recognize official `tool` and `checkpoint` steps (parse only)

**What to build:** an Antigravity print-mode stream that emits official Headless `step_update` lines with `step_type` `tool` or `checkpoint` is treated as known protocol, not as `jsonl.unknown_event`. The Feishu user still does **not** get process/progress cards or tool-call bodies for those steps — parse only. A later `agent_response` + SUCCESS reply is unchanged.

**Blocked by:** None (can start immediately).

**Status:** done

## Parent

[docs/specs/agy-jsonl-compat.md](../../../docs/specs/agy-jsonl-compat.md) — section (a) protocol mapping.

## What to build

Official agy Headless vocabulary includes `step_type` values `user_input`, `agent_response`, `tool`, and `checkpoint`. Today only `agent_response` is handled and `user_input` / `system_message` / `error_message` are silently ignored; `tool` and `checkpoint` increment protocol drift and log `unknown_event` with `eventType` set to the step type.

After this ticket, those official types are in the known set. A fixture shaped like the incident (many `tool` steps plus one `checkpoint`, no reply yet) produces **no** `tool_use` / `tool_result` / `text` events and does **not** increment `unknownEvents` for those lines. Markdown and card reply modes therefore cannot open a tool progress stream from this translator output.

`ACTIVE` and `DONE` are both recognized. `tool_name`, `tool_info`, and optional `subagent_info` are tolerated and ignored. A truly unknown `step_type` or `event` still increments drift.

This ticket does **not** classify empty SUCCESS or add `--print-timeout`.

## Acceptance criteria

- [x] A committed JSONL fixture with at least one `tool` step (including `tool_name` / `tool_info`) and one `checkpoint` step, plus `init`, yields `protocolDrift().unknownEvents === 0` for those lines and no `tool_use` / `tool_result` events.
- [x] The same fixture may include both `ACTIVE` and `DONE` for the same tool index without logging `unknown_event` for `tool`.
- [x] An existing captured success stream (`user_input` + `agent_response` + SUCCESS `response`) still maps to system + `final_text` + `done(normal)` as today.
- [x] A still-unknown `step_type` (and an unknown top-level `event`) still increment `unknownEvents` and do not throw.
- [x] Already-silent `user_input` / `system_message` / `error_message` stay silent (no new events, no new drift).
- [x] Tests run at the translator seam with fixtures. Live agy capture is optional local evidence only.

## Blocked by

- None (can start immediately).
