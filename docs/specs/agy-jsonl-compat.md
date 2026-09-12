# Spec: Antigravity JSONL compatibility (tool / checkpoint / print-timeout)

Status: ready-for-agent (docs track). Grill closed by product owner. Do not reopen locked decisions.
Written 2026-09-12 from the verified 哈基米 / cursor-agy incident (~263c7d) and official agy Headless `stream-json` vocabulary.

This document is the destination. Tickets under `.scratch/agy-jsonl-compat/issues/` are disposable execution slices. Implementers claim tickets from docs draft PR [#27](https://github.com/Rainnystone/larkent/pull/27); they push product code only to a later, separate feat PR.

---

## Problem Statement

A Feishu user talking to an Antigravity (`agy`) profile can watch a long tool-using turn produce **no chat reply**. The bridge logs a pile of `jsonl.unknown_event` lines (`eventType=tool`, one `checkpoint`), then a SUCCESS `result` with an empty `response` after the default `--print-timeout` (five minutes). Outbound treats that as a clean empty finish, logs `outbound.skip-empty`, and never posts `↗ sent`. The chat goes mute.

The user cannot tell a finished-with-nothing turn from a print-timeout that dropped the answer. The operator cannot tell official Headless steps from real protocol drift.

## Solution

The Antigravity translator understands the official Headless step vocabulary so `tool` and `checkpoint` stop looking like unknown events. Markdown (and card) reply modes still do **not** push Feishu process/progress cards for those tools — parse only.

An empty SUCCESS `result` that follows a print-timeout is **not** a clean empty finish. The run emits a timeout hint so outbound has something to send and does not `skip-empty`.

Operators can set agy's `--print-timeout` as a first-class antigravity profile option. This spec does not ship a local-box `10m` patch; that stays with the Coder on the host.

These three outcomes have different acceptance and stay separate.

---

## Seams

Prefer existing seams. Do not invent a parallel event bus.

1. **Translator seam (primary).** `AntigravityJsonlTranslator.translate(line)` already turns one NDJSON object into `AgentEvent[]` and records protocol drift. This is the highest seam for (a) recognizing `tool` / `checkpoint` and (b) classifying empty SUCCESS after print-timeout. Cloud tests drive it with JSONL fixtures. Live `agy -p --output-format stream-json` capture is local evidence only.

2. **Options / argv seam.** `parseAntigravityAgentOptions` plus `buildAntigravityArgs` already own the print-mode flag list. This is the seam for (c) first-class `--print-timeout`. The adapter forwards the parsed option and still knows nothing about Feishu.

3. **Outbound seam (fallback only).** `sendFinalReply` skips when `renderText` is empty. Use this seam only if a timeout cannot be expressed as `AgentEvent`s that the existing reducer + `renderText` already render as non-empty. Do not reuse the bridge idle-watchdog notice ("N 分钟无响应") as the print-timeout hint — that copy is the `/timeout` idle watchdog, and N would be wrong.

Ideal count: two seams (translator + options/argv). Channel work is a last resort, not a third feature.

---

## User Stories

1. As a Feishu user on an antigravity profile in markdown reply mode, I want a long tool-using turn that hits print-timeout to leave a visible timeout hint in the triggering chat, so I know the bot did not silently finish.
2. As a Feishu user, I want a short turn that really produced no text and did not time out to stay quiet (current `skip-empty`), so I am not spammed with fake timeout notices.
3. As a Feishu user, I want a normal SUCCESS with a `response` (or held-back `agent_response` text) to keep posting that text as the final reply, so existing pong-style turns stay unchanged.
4. As a Feishu user, I want a result `ERROR` / `FAILED` to keep posting the error, so location and precondition failures still surface.
5. As a Feishu user in markdown mode, I do **not** want a process/progress card or tool-call body for each `tool` step, so a 137-tool turn does not flood the chat with process chrome.
6. As a Feishu user with `showToolCalls` on, I still do not want Antigravity tool steps to become Feishu tool blocks in this change, so "parse only" is the same whether the preference is on or off.
7. As a Feishu user in card reply mode, I do not want this change to start a tool-progress card for agy tools, so card and markdown stay aligned on parse-only.
8. As a Feishu user in text reply mode (one final markdown post), I want the same timeout hint at the end of a print-timeout, so reply mode does not change the mute fix.
9. As a Feishu user, I want a `checkpoint` step to be silent, so a compaction/checkpoint does not look like a failure or an unknown event.
10. As a Feishu user, I want `/resume` after a print-timeout to still have a resume handle from `init` / `result.conversation_id`, so the conversation is not thrown away because the turn timed out.
11. As an operator reading profile logs, I want official `tool` and `checkpoint` steps to stop incrementing `jsonl.unknown_event`, so drift counts mean real unknowns.
12. As an operator, I want a truly unknown `step_type` or `event` to keep incrementing protocol drift and logging `unknown_event`, so a future agy vocabulary change is still visible.
13. As an operator, I want `user_input`, `system_message`, and `error_message` steps to stay silently ignored, so this change does not reclassify already-known silent types.
14. As an operator, I want both `ACTIVE` and `DONE` tool steps to be recognized, so a start/finish pair does not log 2× unknown_event.
15. As an operator, I want `tool_name` and `tool_info` (and `subagent_info` if present) to be tolerated without throwing, so a richer official payload does not crash the translator.
16. As an operator, I want the incident shape (~many `tool` + one `checkpoint` + no `agent_response` + empty SUCCESS) to be a committed fixture, so Cloud CI can regress it without a live agy.
17. As an operator, I want a live local `stream-json` capture to be optional evidence, so Cloud agents are not blocked on installing or running agy.
18. As a profile owner, I want to set antigravity `printTimeout` on `agent.options` and have print-mode argv include `--print-timeout <value>`, so I can raise the ceiling without a host-local argv patch.
19. As a profile owner, I want an unset `printTimeout` to omit the flag, so existing profiles keep agy's default five-minute ceiling.
20. As a profile owner, I want an invalid `printTimeout` rejected at options parse, so a typo fails at config load rather than at spawn.
21. As a profile owner, I do **not** want this change to write `10m` into the repo as the new default, so the Coder's local box patch stays a host decision.
22. As a profile owner, I want changing `printTimeout` not to invalidate stored resume handles, so raising the ceiling does not force `/new`.
23. As a Feishu user, I want a SUCCESS that has empty `response` but held-back `agent_response` `text_delta` to still flush that text (current `finish`/`fail` behavior), so a truncated stream does not look like a print-timeout.
24. As a Feishu user, I want usage events on the SUCCESS line to keep working when we emit a timeout hint, so token logs are not dropped because the response was empty.
25. As an implementer, I want the timeout hint to survive `finalAnswerOnly` projection (antigravity's `final-answer` reply mode), so the hint is not stripped because it lived only in tool blocks.
26. As an implementer, I want the three slices to stay independently demoable, so a translator-only parse fix can land without waiting on config, and config can land without waiting on the mute fix.
27. As a dual-track Coder, I want to claim one ticket from the docs PR and open a clean feat PR from `master`, so docs scaffolding never appears on the code branch.

---

## Implementation Decisions

- **Closed official `step_type` set for "known, not drift":** `user_input`, `agent_response`, `tool`, `checkpoint`, plus the already-silent `system_message` and `error_message`. `agent_response` keeps today's text-holding behavior. `tool` and `checkpoint` are recognized and produce **no** `tool_use` / `tool_result` / `text` events. Future types still increment `unknownEvents` and log `jsonl.unknown_event` with `eventType` equal to the step type (same as today).
- **Parse only for tools.** Official tool steps may carry `tool_name` and `tool_info` (`name`, `parameters`, `output`, optional `error`) and optional `subagent_info`. Tolerate and ignore those fields. Do not map them onto shared `AgentEvent` tool calls in this spec. Markdown mode therefore cannot open a lazy progress stream from tools, because there is no tool block to render.
- **Empty SUCCESS after print-timeout is a classified timeout, not `done(normal)` with no body.** Classifier, in order:
  1. If the `result` envelope has a first-class timeout / reason / error field that means print-timeout, trust it. Encode whatever the captured official payload actually has in the fixture. Do not invent a field agy does not emit.
  2. Otherwise use the incident heuristic: `status` is SUCCESS (or equivalent success), `response` is missing or empty, there is no held-back `agent_response` text, and this run already saw at least one recognized `tool` or `checkpoint` step → emit the timeout hint.
  3. Otherwise keep today's clean empty finish (no hint; outbound may `skip-empty`).
- **Timeout hint must make outbound non-empty.** Prefer an `AgentEvent` the existing reducer already turns into non-empty `renderText`: a `final_text` hint, or an `error` whose message is shown. Do **not** emit `terminationReason: 'timeout'` unless the idle-watchdog copy is also changed to a distinct print-timeout notice — that copy belongs to the bridge `/timeout` watchdog and would read as "0 分钟无响应". Channel changes only if those existing events cannot carry a distinct hint through `finalAnswerOnly` projection.
- **Hint copy** is implementer-owned. It must be visibly about print-timeout / no reply, and must not be the idle-watchdog sentence. English or Chinese is fine if it is consistent with nearby antigravity notices.
- **Resume handle is preserved** on a timeout-classified SUCCESS (same `system` / `done` resume handle rules as a normal result).
- **`--print-timeout` is an antigravity-only option.** Name it `printTimeout` on `agent.options`. Value is a duration string agy already accepts (examples: `30s`, `5m`, `10m`, `1h`). When set, argv includes `--print-timeout` and that value. When unset, omit the flag. Reject unknown keys in the existing strict parse path; reject a present-but-invalid duration. Do not add this option to other agent kinds.
- **Default stays "omit the flag"** (agy's own five-minute default). The Coder's local `10m` host patch is out of the feature PR.
- **Policy fingerprint does not include `printTimeout`.** Changing the ceiling must not force a new session.
- **Adapter remains Feishu-ignorant.** Translator and argv/options do the work. Shared bot/card code changes only at the outbound fallback seam above.
- **No product code on the docs PR.** No feat/code PR from this track. No copying `.scratch/` scaffolding onto a later feat branch.

## Testing Decisions

- **Good tests assert observable translator / argv behavior**, not log-line counts as the only signal. A fixture that used to increment `unknownEvents` for `tool` / `checkpoint` must increment `0` for those lines. A print-timeout empty SUCCESS fixture must emit a hint event; a clean empty SUCCESS fixture must not.
- **Highest seam first.** Protocol and mute-fix tests construct an `AntigravityJsonlTranslator`, feed fixture objects (or parsed JSONL lines), and assert `AgentEvent[]` plus `protocolDrift()`. Config tests parse options and assert argv. If the mute fix needs to prove outbound non-emptiness, reduce the events with the existing run-state reducer and `renderText` (or the emptiness check `sendFinalReply` uses) — still no live Feishu.
- **JSONL fixtures, not live agy, in Cloud.** Commit incident-shaped fixtures (many `tool` + one `checkpoint` + empty SUCCESS; a short clean empty SUCCESS; a normal `agent_response` + SUCCESS; an `ERROR` result). Live stream-json capture is allowed as local evidence in a delivery note; CI must not require `agy` on PATH.
- **Prior art:** existing Antigravity translator tests (captured print-mode success, `result.response` preferred over `text_delta`, ERROR mapping, unknown-event ignore, `finish`/`fail` flush). Existing Antigravity argv tests (print-mode flags, `--conversation` resume, sandbox reject). Follow that style: inline or small fixture objects, `collect(translator, lines)`, exact event equality where the stream is small.
- **Do not add a real-agy smoke for this spec.** The existing optional Antigravity real smoke stays optional and is not the acceptance path.

## Out of Scope

- Feishu process/progress cards, tool-call blocks, or CoT bubbles for Antigravity `tool` steps.
- Changing the host's running profile to `10m` (Coder / local box).
- Changing agy's default by always passing `--print-timeout` when the option is unset.
- Mapping `tool_info` onto shared `tool_use` / `tool_result` (a later spec).
- Changing other agent translators, reply modes, or idle-watchdog semantics.
- Upstream changes to agy Headless or `--print-timeout` itself.
- Product implementation on this docs PR; merging this PR to `master` before the feat PR is reviewed.

## Further Notes

- Official Headless stream: `init` → `step_update`* → one `result`. Observed `step_type`: `user_input` / `agent_response` / `tool` / `checkpoint`. `state`: `ACTIVE` | `DONE`. Tool steps carry `tool_name` / `tool_info`. Default print-timeout is five minutes.
- Verified incident: 哈基米 / cursor-agy bridge run ~263c7d. ~137× `eventType=tool` + 1× `checkpoint` unknown_event; no `agent_response` text; default `--print-timeout 5m` → empty SUCCESS `result` → `outbound.skip-empty` → no `↗ sent`.
- Open risk: official `result` may still say SUCCESS with an empty `response` and **no** dedicated timeout flag. Ticket 02 must encode the captured shape. If no flag exists, the incident heuristic is the acceptance path.
- Dual-track: see `.scratch/agy-jsonl-compat/README.md`.
