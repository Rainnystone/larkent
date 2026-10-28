# grok (grok 1.0.71)

Spawn: `grok --prompt-file <TMP>/prompt.md --output-format streaming-json --rules <RULES> --always-approve --no-auto-update` (prompt in a temp file, bridge prompt via `--rules`).

Observed:

- Repeated `available_commands` records bracket each model segment (before thinking, before text, after each tool call) — several per turn, each a large identical tool list.
- `thought` deltas, then incremental `text` deltas (narration) precede `tool_call_update` records for the same `toolCallId` (`in_progress` → `completed`, `rawOutput` grows inside the updates).
- Post-tool answer streams as fresh `text` deltas; the terminal `end` record carries usage/`stopReason` but no text. No repeat across boundaries.
- During the 45 s sleep stdout is fully silent (gap 7.7 s → 52.8 s).
- Stop mid-answer: stop triggered on the first `thinking` event (~5.9 s); SIGTERM → exit code 143 ~1.2 s later; trailing records were all thinking deltas.
- `error-unknown-model`: a stdout `{"type":"error"}` record *and* a stderr `Error: …` line for the same failure, then exit code 1.
