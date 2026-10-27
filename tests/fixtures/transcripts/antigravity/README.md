# antigravity (`agy` 1.4.4)

Spawn: `agy -p <PROMPT> --output-format stream-json --dangerously-skip-permissions --disable-slash-commands` (prompt in argv; bridge prompt prefixed).

**Network**: same proxy requirement as cursor — without `HTTP(S)_PROXY`/`ALL_PROXY` the run ends with `result.status: "ERROR"` (`Eligibility check failed … googleapis.com … EOF`), exit 1.

Observed:

- `init` (tools list, conversation_id) then `step_update` records: `user_input` DONE → `agent_response` ACTIVE/DONE pairs → `tool` ACTIVE/DONE → more `agent_response` → terminal `result`.
- Narration lives in `agent_response` step content; a `step_index` groups one model segment. Tool runs are `step_type:"tool"` steps.
- Answer text is not streamed: the terminal `result.result.response` holds the full answer once.
- During the 45 s sleep stdout is silent; at ~15 s into the silence a single stderr line appears: `root agent idle; waiting up to 30m0s for 1 background task(s)`.
- Stop mid-answer: answer arrives complete in `result`; SIGTERM after first `final_text`, exit code 0 ~0.4 s later.
- `error-unknown-model`: stderr `invalid model selection` detail *and* a stdout `result` record with `status:"ERROR"` carrying the same message, exit code 1.
