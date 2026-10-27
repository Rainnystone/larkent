# cursor (cursor-agent, see note on versions)

Spawn: `cursor-agent -p --output-format stream-json --force --sandbox disabled --approve-mcps --trust <PROMPT>` (prompt positional; bridge prompt prefixed).

**Network**: this machine's Cursor endpoint is only reachable through the local proxy; captures ran with `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` exported (127.0.0.1:7890). Without it the CLI dies on stderr (`Client network socket disconnected … TLS`) with empty stdout.
**Version**: `cursor-agent --version` printed `2026.09.08-6caf4ff` at task start; the CLI self-updated during capture — headers record `2026.10.22-27dcf5f`.

Observed:

- `system/init` → `user` → long `thinking`/`delta` stream → `thinking`/`completed` → `assistant` → `tool_call` started/completed → `assistant` → `result`.
- The `assistant` message carrying narration is a single complete text block, immediately followed by the `tool_call` record at the same timestamp. Thinking deltas do **not** produce `thinking` AgentEvents under today's translator.
- **Text repeats across boundaries**: the terminal `result.result` concatenates narration + answer (`I'll run … printed.` + `The command finished …`).
- During the 45 s sleep stdout is silent (~46.6 s gap).
- Stop mid-answer: like codex, the answer arrives complete inside `result`; SIGTERM after the first `final_text`, exit code 0 ~0.8 s later.
- `error-unknown-model`: stderr-only `Cannot use this model: … Available models: …` at ~12 s, exit code 1, no stdout records after `system`/`init`.
