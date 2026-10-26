# Grok: a long answer trips the idle watchdog

Status: ready for implementation. Tickets: `.scratch/grok-idle-watchdog/issues/`.

## Problem

With agent kind `grok`, a run whose answer phase (pure text, no tool calls) streams for longer than the run idle timeout is stopped by the bridge idle watchdog while Grok Build is still writing. The user gets an `idle_timeout` card instead of the answer, and the answer that was buffered so far is withheld.

The default timeout is 15 minutes (`DEFAULT_RUN_IDLE_TIMEOUT_MINUTES`, `src/config/schema.ts:309`), configurable 1-120 minutes per profile (`preferences.runIdleTimeoutMinutes`) or per scope. So in production the bug needs an answer longer than the configured timeout; with a short timeout it is easy to hit.

## Evidence

1. **Code.** `GrokJsonlTranslator.translate` (`src/agent/grok/jsonl.ts:56-57`) sends every `{"type":"text"}` line to `queueText`, which appends to `pendingText` and returns `[]` (`queueText`, around line 113). Nothing reaches the channel until `end`. The watchdog (`src/bot/idle-watchdog.ts`, `createIdleWatchdog`) is rearmed only from `processAgentStream` (`src/bot/channel.ts:3126-3140`): `watchdog.arm()` on a `system` event, `watchdog.noteDelivered()` on a delivered event. The runner (`src/agent/runner/jsonl-cli-runner.ts`) yields only what the translator returns, so the stdout lines themselves do not count.
2. **Raw stream (real Grok Build 1.0.x, default model, headless `--output-format streaming-json`).** A prompt for a ~3000-character essay with no tools produced 4 `thought` lines, then 3934 `text` lines between t=9.5 s and t=114.5 s, then `end` at t=114.6 s. That is ~105 s of continuous output during which the translator emits zero events.
3. **Adapter harness.** The real `GrokAdapter` plus `createIdleWatchdog` with `idleTimeoutMs=10000`, same prompt: last delivered event is a `thinking` delta at t=16.6 s, the watchdog fires at t=26.6 s (`stopRequest = bridge-idle-watchdog`), the run ends `done/interrupted` and no `final_text` is delivered.
4. **Test bridge** (`runIdleTimeoutMinutes: 1`, master build): a no-tool essay prompt whose answer finished in 56 s was delivered normally; a longer one was stopped at 67 s with `agent idle-timeout idleTimeoutMs=60000`, `card final terminal=idle_timeout stopReason=bridge-idle-watchdog`. A follow-up run of the same kind hit the same timeout.

## Root cause

Grok declares `replyMode: 'final-answer'`. Its translator correctly holds the answer back until `end` (so it is delivered once), but it signals nothing while it holds back. The watchdog only sees translator output, so to it a long answer looks like silence. This is the same gap Devin had; it was closed for Devin in `src/agent/devin/transcript.ts` by returning a bare `{ type: 'system' }` per buffered chunk.

## Chosen fix

In `GrokJsonlTranslator.queueText`, after appending a non-empty chunk to `pendingText`, return `[{ type: 'system' }]` instead of `[]`. The channel already treats a bare `system` event as liveness only: it rearms the watchdog (unless the run is interrupted), passes it to `recordSession` (which ignores events without `resumeHandle`), and renders nothing. Empty chunks keep returning `[]`. Hold-back, `final_text` on `end`, and the flush-on-error/fail paths are unchanged.

Options considered:

| Option | Verdict |
|---|---|
| Bare `system` event per buffered `text` chunk (mirrors Devin) | **Chosen.** One-line translator change, no channel change, no rendering. |
| Stream answer as `text` deltas | Rejected: breaks the final-answer contract (double reply, as Devin had). |
| Rearm the watchdog on raw stdout lines in the runner or channel | Rejected: changes shared watchdog/runner semantics for every adapter. |
| Throttle to one `system` per N ms | Not needed: the event is consumed with no I/O; can be revisited if profiling shows cost. |

## Non-goals

- No changes to the Devin, Codex, Kimi, Cursor, Claude or any other adapter.
- No change to `src/bot/channel.ts`, `src/bot/idle-watchdog.ts` or watchdog semantics, the runner, or run-outcome.
- No change to how a partial answer is handled after an idle timeout.
- No refactors.

## Failure cases to cover

- Long answer: many `text` chunks spaced closer than the timeout but spanning more than it must not trip the watchdog, and the whole answer arrives once as `final_text`.
- Short answer: still exactly one `final_text`, no `text` delta, no visible extra message.
- Text before a tool call: still kept and separated from the later answer.
- `error` / `fail` after buffered text: still flushed as `text` before the error.
- Empty `text` chunk: no event.

## Testing

1. Translator unit (`tests/unit/agent/grok-jsonl.test.ts` or a new grok unit file): every non-empty `text` line yields exactly one bare `{ type: 'system' }` and no `text`; `end` yields one `final_text` equal to the concatenation.
2. Regression seam, red on `origin/master`: the real `GrokJsonlTranslator` (via the runner or a scripted stream) fed `text` chunks spaced under the timeout but spanning past it, consumed by the channel's stream processing or `createIdleWatchdog` with fake timers; assert no `bridge-idle-watchdog` stop and the full answer delivered once.
3. Update any Grok goldens or contract tests that pin the translator's exact event list, only as far as the new `system` events require.
4. Keep green: all other grok tests, `tests/integration/bot/idle-lifecycle.test.ts`, `tests/unit/bot/final-reply.test.ts`, Devin tests.
5. E2E on the test bridge (grok, `runIdleTimeoutMinutes: 1`): the long no-tool answer from Evidence 4 arrives whole with no `idle_timeout`; a short question still gets exactly one reply.
