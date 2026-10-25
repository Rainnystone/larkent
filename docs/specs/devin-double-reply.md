# Devin: every answer is delivered twice

Status: ready for implementation. Tickets: `.scratch/devin-double-reply/issues/`.

## Problem

With agent kind `devin` and `messageReply=markdown`, every answer shows up twice in the chat:

1. an interactive streaming card (the progress stream) whose final content is the answer, and
2. a separate markdown post with the same text.

Example (test bridge, group chat, `showToolCalls=false`): the user asks "what is 2+2?". Devin answers "4". The chat shows a card reading "4" and, right after it, a post reading "4". Three group questions in one session produced three card+post pairs with identical text. The bridge log has exactly one `sent markdown` line per turn, so this is one bridge delivering twice, not two bridges.

Card mode doubles the same way. DM and group take the same delivery path, so DM doubles too. CoT mode and `messageReply=text` deliver once (no progress stream).

## Root cause

All non-Claude agents declare `replyMode: 'final-answer'`. The contract this sets up between translator and channel is:

- the translator **holds back** the current assistant message;
- if a tool call (or a new message) follows, the held-back text is flushed as a `text` event: progress narration that goes into the progress stream;
- at a normal end the held-back message is emitted **only** as `final_text`, and the channel delivers it as a dedicated final reply.

Codex (`src/agent/codex/jsonl.ts` `queueAgentMessage` / `prependPendingText`), Grok (`src/agent/grok/jsonl.ts` `pendingText`) and Cursor (`src/agent/cursor/jsonl.ts` `pendingAssistantText`) all follow it. Devin does not:

- `src/agent/devin/metadata.ts:42` declares `replyMode: 'final-answer'`.
- `src/agent/devin/transcript.ts:15-22` (`agent_message_chunk`) emits every chunk as `{ type: 'text', delta }` **and** accumulates it into `this.answer`.
- `src/agent/devin/transcript.ts:41` (`finish`) then emits `{ type: 'final_text', content: this.answer }`: the same words a second time.

On the channel side (`src/bot/channel.ts`):

- `:2044-2045` sets `finalAnswerOnly` from the descriptor.
- In the markdown branch (`:2239-2318`) the `text` deltas make the state non-empty, so `shouldOpenProgressStream` (`:2448`) opens the lazy progress stream (`createLazyProgressStream`) and renders the answer into it.
- `:2293-2295` `terminalState = finalReplyState(stream, visible)` (`:2467`) calls `finalReplyFor(..., { replyMode: 'final-answer', streamed: true })` (`src/bot/cot.ts:260`). `streamedFinalAnswer` reduces the reply to exactly `finalText`.
- `deliverFinalReply(..., dedicatedFinal: true)` reaches `settleStreamDelivery` (`:2729`). It records the stream message as a non-answer id (`noteNonAnswerId`) and, at `:2750`, still sends the dedicated final reply. Result: card + post.
- The card branch (`:2155-2238`, `:2214-2216`) is identical, so card mode doubles too.

The channel behaves as designed. The comment on `finalReplyState` (`:2452-2466`) assumes the stream holds only progress and the answer lives only in `finalText`. The Devin translator breaks that assumption.

## Chosen fix

Make `DevinTranscriptTranslator` follow the final-answer contract, Codex-style:

- `agent_message_chunk`: append to a held-back `pending` buffer for the current message id and emit **nothing**.
- When a different message id arrives, or a `tool_call`/`tool_call_update` creates a new tool: flush `pending` as one `{ type: 'text', delta }` (with a trailing paragraph break, as Cursor/Grok do), placed **before** the tool event, then reset.
- `finish('end_turn')`: emit `pending` only as `final_text`, then `done`.
- `finish('cancelled')` / user stop: flush `pending` as `text` (today's behaviour keeps streamed text visible on stop, and `final_text` is withheld on cancel), then `done`.
- `fail(...)`: flush `pending` as `text` before the `error` event so partial output is not lost (Codex does the same on abnormal end).

No channel change. `final-answer` stays correct for Devin.

### Why this option

| Option | Verdict |
|---|---|
| **A. Translator holds back the final message (chosen)** | Fixes the root cause where it is: the one translator that breaks the shared contract. The change is small and local, and it matches Codex/Grok/Cursor, so all modes (card, markdown, text, CoT, DM, group) behave the same as the other agents with no new branches. |
| B. Switch Devin to `stream-deltas` | All narration would become answer body: with `showToolCalls=false`, pre-tool "I will check X…" text lands in the final reply in text and CoT modes. It also turns the stream card into the answer receipt, a different journal shape from the other agents. Rejected. |
| C. Channel suppresses or patches the final reply when the stream already shows `finalText` | Treats the symptom. It adds a string-equality heuristic to shared delivery code that every agent uses, still lets a progress card exist only to repeat the answer, and fails when the outcome notice or markdown normalization makes the strings differ. Rejected. |

### Trade-offs

- The final answer no longer token-streams; it appears once, whole, at the end. The other final-answer agents work the same way. The Typing reaction (markdown/text) and the card (card mode) are the ack in the meantime.
- Mid-turn narration before tool calls stays visible in the progress stream (Codex/Grok behaviour). Unlike Cursor, it is not discarded. This is a deliberate choice: it keeps today's Devin progress visibility. With `showToolCalls=false` the user sees narration only where it was already shown, and the dedicated final reply holds only the answer body.
- A turn whose only output is the answer never opens a progress stream (`shouldOpenProgressStream` sees no visible text). The user sees Typing, then one post.

## Non-goals

- No change to `src/bot/channel.ts`, `src/bot/cot.ts`, delivery, journal or receipts.
- No change to Devin ACP transport (`src/agent/devin/acp.ts`), tool rendering or thinking events.
- No change to other agents' translators.
- No Cursor-style discarding of pre-tool narration.

## Failure cases

| Case | Expected |
|---|---|
| Answer only, no tools | No progress stream. Exactly one final message (post in markdown, card in card mode) with the answer. |
| Narration → tool → answer | The progress stream shows the narration (and the tool if `showToolCalls=true`). The dedicated final reply holds only the answer. The answer text appears once. |
| Two messages with different ids and no tool between them | The first is flushed as progress text; the second is the final answer. |
| User stop (`cancelled`) mid-answer | Partial text is flushed as `text` into the stream. No `final_text`. No duplicate. |
| Error after partial text | Partial text is flushed as `text`, then `error`. The error notice is delivered as today. |
| Replayed history (`replay=true`) | Ignored, as today. |
| Empty answer at `end_turn` | No `final_text`. The existing skip-empty path applies. |

## Testing

Seams, red before green:

1. **Translator unit**, `tests/unit/agent/devin-acp.test.ts`: chunks yield no `text`; `finish('end_turn')` yields exactly one `final_text` equal to the concatenated chunks; a tool call flushes pending as `text` before `tool_use`; a message id change flushes; cancel and fail flush as `text`. Update the existing assertion that a chunk returns `{ type: 'text' }` (line 9): it encodes the bug.
2. **Channel delivery**, an integration test next to `tests/integration/bot/feishu-uuid-idempotency.test.ts` / `automation-reply-state.test.ts` that uses their recording channel harness. Run the profile with `agentKind: 'devin'` and a fake agent whose events come from a real `DevinTranscriptTranslator` fed scripted ACP updates. Assert that **exactly one** visible message contains the answer text, in `messageReply=markdown` and in `messageReply=card`, for (a) answer-only and (b) narration → tool → answer. The test must fail on `origin/master`.
3. Keep green: `tests/unit/bot/final-reply.test.ts`, `tests/unit/bot/cot.test.ts`, `tests/integration/bot/skip-cli-already-sent.test.ts`, plus the Codex/Grok/Cursor translator tests.

E2E acceptance on the test bridge (operator machine, Devin agent, `messageReply=markdown`, group and DM):

- one reply per question, no card+post pair;
- the Typing reaction appears on the question and is removed after the reply;
- the reply body is only the answer (no narration or tool lines when `showToolCalls=false`).
