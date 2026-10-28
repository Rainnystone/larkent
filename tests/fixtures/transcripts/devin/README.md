# devin (devin 3000.11.228, ACP)

**Version**: `devin --version` printed `3000.11.92` at task start; the CLI
self-updated before capture — headers record `3000.11.228 (053434014dbd)`.

Capture path: real `DevinAdapter.run`; `DevinTranscriptTranslator.prototype.translate`
is teed so every ACP `session/update` `params.update` lands as a
`{"t":ms,"update":…}` record. Stop uses the production `run.stop()`
(`session/cancel` notify + SIGTERM to the process group).

**Environment caveat**: capture must run with `ACP_BACKEND` **unset**
(`env -u ACP_BACKEND pnpm exec tsx tests/helpers/capture-transcripts.ts devin <scenario>`).
When `ACP_BACKEND` is inherited (e.g. inside an IDE ACP session), `devin` expects
the *ACP host* to authenticate (`devin auth status` reports "Not logged in" and
`session/prompt` fails with "ACP host has not authenticated"). With it unset the
CLI uses its own stored login. This mirrors production: the bridge spawns `devin`
outside any ACP-host context.

Observed:

- Session updates: `session_info_update` records bracket the turn;
  `agent_thought_chunk` and `agent_message_chunk` carry incremental text with
  per-chunk `messageId` meta; `tool_call`/`tool_call_update` carry `toolCallId`,
  `rawInput`, `rawOutput`, `status` (`in_progress`→`completed`); `usage_update`
  arrives per segment.
- Narration precedes tool calls as `agent_message_chunk` text before the first
  `tool_call` update — chunks are deltas; message boundaries are marked by a
  change in `cognition.ai/messageId` (translator flushes pending text there).
- Answer text does not repeat across message ids; each chunk id is distinct and
  `final_text` is assembled from `agent_message_chunk` deltas at `end_turn`.
- During the 45 s shell sleep, updates keep arriving: `tool_call_update` heartbeats
  (~every few seconds) plus `session_info_update`/`usage_update` — stdout is
  never silent.
- Stop mid-answer: `run.stop()` sends `session/cancel`; chunks stop immediately,
  terminal event is `done`/`interrupted`, process exits **code 0** ~200 ms later.
- `error-unknown-model`: the failure surfaces as a translator `error` event
  (`Devin model unavailable: lark-nonexistent-model-0`) — the model id is
  validated client-side against `session/new`'s config options before
  `session/prompt`, so **zero** session/update records exist for the prompt;
  stderr has only init logs; exit code 0.
