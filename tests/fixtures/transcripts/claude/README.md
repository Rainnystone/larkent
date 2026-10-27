# claude (Claude Code 2.1.283)

Spawn: `claude -p --output-format stream-json --verbose --permission-mode bypassPermissions --append-system-prompt-file <TMP>`; prompt on stdin; bridge system prompt via the temp file.

**Backend caveat**: the init record shows `model: glm-5.2[1m]` and stderr warns that `ANTHROPIC_API_KEY` (or another auth source) takes precedence over the claude.ai login — on this machine Claude Code is routed to a **non-Anthropic backend** via env. The stream-json protocol shape is Claude Code's own, but the model behind it is not Claude, so model-behaviour observations (e.g. the `thinking_tokens` cadence, how long thinking precedes answer text) may differ under a real Anthropic backend. `model` values are kept verbatim in all fixtures because translators surface them into `system` AgentEvents (`ClaudeStreamTranslator` and `CursorJsonlTranslator` copy `init.model` onto the event's `model` field) — they are part of the event contract, not just metadata.

Observed:

- Startup emits `system` records (`hook_started`/`hook_response`, `init`, `commands_changed`, `api_retry`) before any assistant content.
- Narration precedes the tool call inside the *same* assistant `message.id`: the message's `content` array first gains a `text` block, then a `tool_use` block; `tool_result` arrives in a `type:"user"` record.
- The terminal `result`-subtype record carries usage/stop_reason but **no** answer text; answer text exists only in `assistant` deltas. No repeat across boundaries.
- During the 45 s shell sleep the CLI keeps emitting `system`/`thinking_tokens` records roughly every 40–150 ms (stdout is never silent).
- Stop mid-answer: this model spent 44 s thinking before any answer text, so the stop triggered on the first `thinking` event, not answer text. SIGTERM to the process group → exit code 143 within ~0.5 s; trailing records stop immediately.
- `error-unknown-model`: error surfaces as a normal-looking result stdout line whose text is `API Error: 400 …` (provider-specific wording), exit code 1.
