# 03: Problem A — skip the bridge's final reply when the agent already delivered to the current chat

**What to build:** One user turn produces one post even when the agent ignores ticket 02 and IM-sends to the triggering chat itself. The shared run-state reducer watches the agent's `tool_use` / `tool_result` events for a successful `lark-cli im +messages-send` / `+messages-reply` / `send-card` invocation and records the target chat id on the run state (`directImSentChatIds`). When the run ends with `terminal === 'done'` and the triggering chat is in that set, `sendFinalReply` posts nothing and logs `outbound.skip-cli-already-sent`. Error / interrupted / idle-timeout terminals still post their notice so the user is never left without a signal. Detection lives in the shared reducer, so it is identical for every agent kind.

**Blocked by:** 02

**Status:** in-progress

- [ ] Reducer recognises a lark-cli IM send from `tool_use` input (command string containing `lark-cli im` with `+messages-send`, `+messages-reply` or `send-card` and a `--chat-id <oc_/ou_…>` — also the reply form where the chat is implied by `--message-id`, resolved to the current chat when the message id belongs to the batch) and confirms success from the matching `tool_result` (exit success / JSON without error code). Unsuccessful or malformed sends record nothing.
- [ ] `RunState.directImSentChatIds` is populated per run and is not persisted anywhere.
- [ ] `sendFinalReply` skips only when `terminal === 'done'` **and** the target chat id is recorded; all other terminals behave as today.
- [ ] Skip is logged as `outbound.skip-cli-already-sent` with `scope`, `chatId`, `mode`; metric `outbound_skip_cli_sent` counted.
- [ ] Card / markdown / text reply modes and final-answer-only adapters all honour the skip (the streamed progress card, if any, is still finalized; only the *extra* final post is suppressed).
- [ ] Rejected approach documented in a code comment or the PR: post-run history check by bot identity (spec ticket quiz option c) — not implemented.
- [ ] Tests: parameterized over all `AGENT_KINDS` with a scripted JSONL stream containing a successful CLI send → exactly one outbound post; the same stream with a failed send → bridge posts the final as today.
- [ ] No `agentKind` branching; no profile or host names.
