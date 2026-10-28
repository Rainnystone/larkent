# codex (codex-cli 0.163.0)

Spawn: `codex exec --json --sandbox danger-full-access -c approval_policy="never" -c shell_environment_policy.inherit="all" --ignore-rules --skip-git-repo-check -C <CWD> -`; the prefixed bridge prompt goes on stdin.

Observed:

- Envelope order: `thread.started` → `turn.started` → `item.*` → `turn.completed`.
- Narration is a complete `item.completed`/`agent_message` *before* `item.started`/`command_execution`; the post-tool answer is a second `agent_message` item. Text does not repeat across items — each `agent_message` is a distinct full message.
- Answer text is not streamed incrementally: each `agent_message` arrives complete.
- During the 45 s sleep stdout is fully silent (~45 s gap between `item.started`/`command_execution` and `item.completed`).
- Stop mid-answer: the whole answer lands in one `agent_message` at end of turn, so a mid-answer stop is only reachable while thinking; SIGTERM was sent after the first `final_text` and codex exited **code 0** ~150 ms later (SIGTERM is handled gracefully, not reported as a signal).
- `error-unknown-model`: `{"type":"error", …invalid_request_error…}` and `turn.failed` stdout records, then exit code 1. Nothing on stderr.
