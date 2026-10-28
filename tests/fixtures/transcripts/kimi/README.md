# kimi (2.1.1)

Spawn: `kimi -p <PROMPT> --output-format stream-json` (bridge prompt prefixed into `-p`; kimi does not read the prompt from stdin). No terminal JSONL record — clean exit ends the turn (`successFinish`).

Observed:

- Non-incremental: each `assistant` line is a complete message. An assistant line carrying narration also carries `tool_calls` in the same record; the final assistant line carries only `content`.
- Tool results do not appear as their own stdout record in these captures — the transcript goes assistant(+tool_calls) → assistant(answer) → `session.resume_hint` meta.
- During the 45 s sleep, stdout is silent; the shell tool's own output (`done`) appears on **stderr** at ~57 s, not in JSONL.
- `stop-mid-answer` could not produce a mid-answer cut: the single assistant line arrives fully formed at the end of a ~47 s silent run, so no text event exists to stop on. The run completed normally (exit 0); SIGTERM was never sent. This is the honest capture — there is no streaming boundary to interrupt.
- `error-unknown-model`: nothing on stdout after `system.version`; the error is stderr-only (`failed to run prompt: Model "…" is not configured`), exit code 1. Translator emits only `done` on clean-exit finish — the error detail lives in `stderrSnapshot`.
