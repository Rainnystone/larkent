# D04 Shared final-answer core, liveness event, tool pairing

Spec: D6, D7, D8, A4. Blocked by: D03.
Touch: `src/agent/types.ts`, new shared core under `src/agent/` (e.g. `src/agent/final-answer/`), `src/agent/{codex,kimi,grok,cursor,antigravity}/jsonl.ts`, `src/agent/devin/transcript.ts`, `src/bot/idle-watchdog.ts`, the event loop in `src/bot/channel.ts` (`processAgentStream` ~3099-3235, `runAgentBatch` system handling ~2037-2045), `src/bot/cot.ts` if it reads `system`, tests, `CONTEXT.md`.

## Why

Six final-answer translators each carry pending text, flush with `\n\n`, dedup of repeated messages, terminal / drift bookkeeping and helper copies (`isRecord`, `stringValue`, `truncate`). Hold-back fixes landed per agent. Liveness is an empty `system` event (`grok/jsonl.ts:118`, `devin/transcript.ts:22`) that the bot special-cases. Open tool calls are tracked in every translator and again in `idle-watchdog.ts`.

## Do

1. Red: shared-core tests driven by the D03 transcripts and by small synthetic sequences: answer only; narration → tool → answer under each declared policy (discard pre-tool, keep as progress, keep last segment as fallback); repeated message dedup; stop keeps held-back text as progress, not `final_text`; error flushes then errors; envelope scrub hook runs before `final_text`; every `tool_use` gets a `tool_result` or a terminal failure; liveness emitted where the CLI shows activity without text.
2. Green: implement the core. Each adapter keeps only protocol parsing into core inputs and a policy declaration. Every policy difference must cite a D03 transcript in a comment or test name.
3. Add the liveness variant to `AgentEvent`. Remove empty-`system` liveness. The bot re-arms the idle bound on any event; `system` handling in the bot reads only session metadata.
4. Make the watchdog the only open-call tracker in the bot; translators keep tool maps only for name refinement / pairing, not for bot state.
5. Re-run the D03b differential baseline and D03a replay tests: snapshots change only for liveness and pairing; any other diff is a regression or a documented bug fix (D13).
6. Delete per-translator hold-back tests that the core suite now covers; keep per-protocol parsing tests. Update `CONTEXT.md` (translator, reply mode, new terms: answer hold-back, liveness event). `/code-review`.

## Acceptance

- [ ] No translator contains its own pending-text / flush / drift bookkeeping or helper copies.
- [ ] No `{ type: 'system' }` without session metadata is emitted anywhere.
- [ ] `tests/unit/agent/grok-idle-liveness.test.ts` (or its replacement) tests the watchdog against the explicit liveness event.
- [ ] D03 replay tests green with only intended diffs; `pnpm test:process` and the seven-CLI bridge contract tests green.
- [ ] No new protocol assumption beyond the D03a transcripts (D12). Real-CLI smokes run in D11, not here.
- [ ] `pnpm ci:local` green; delivery note posted.
