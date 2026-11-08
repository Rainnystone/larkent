# 09: Partial terminal state + duplicate failure text

**Blocked by:** None · **Status:** ready-for-agent

Read Spec D3, D4 and D8. References are from docs-track commit `b8adcd46`; follow the named functions if lines move. Preserve genuine CLI failures. This is state normalization and presentation, not a rule that any text or exit 0 means success.

## Why and where

At 2026-11-08 19:13:35 (Asia/Shanghai), agy reported print timeout; the bridge later logged exit 3 and outcome partial but card terminal error. See `~/.lark-channel/profiles/cursor/logs/bridge-20261108.jsonl:1031–1034,1052–1058`.

The timeout signature is partial (`src/agent/antigravity/stderr-signatures.ts:5–8`); `src/bot/run-outcome.ts:119–122` applies that classification. `src/bot/turn.ts:685–690` first reduces the CLI error into an error state. Partial should map to done (`src/bot/run-outcome.ts:376–380`), but `turn.ts:745–767` calls `finalizeIfRunning`, which preserves an existing error (`src/card/run-state.ts:275–276`). `src/bot/cot.ts:302–309` then appends the print-timeout warning; `turn.ts:727–728` also assigns it to errorMsg. `src/card/text-renderer.ts:18–24` renders both the text block and an `agent 失败` tail. The existing partial tests use a normal done terminal (`tests/integration/bot/run-outcome-stream.test.ts:52–85`), missing this error-to-partial path.

## What to build

Normalize presentation from the settled RunOutcome before rendering. A partial outcome must not keep a stale failed terminal/errorMsg. Emit the print-timeout explanation once across progress/final text/card surfaces, preserving useful partial text. Do not solve this by matching and deleting rendered strings or by weakening real errors. Keep cleanup errors separate from the business outcome.

The separate continue notice (`src/bot/interruption-notice.ts:66–80`) remains a recovery action, not another failed-outcome report. Keep it usable without repeating the same failure explanation. Do not remove continuation or add a new generic dedupe layer.

## Acceptance
- [ ] Add a regression with CLI error terminal + exit 3 + the real print-timeout stderr signature. It fails before the fix, then settles as partial and renders exactly one timeout explanation, without an `agent 失败` tail for that partial.
- [ ] Cover markdown and card/final-reply paths, with and without partial text and an already-streamed warning; useful text is not lost or resent.
- [ ] A genuine current-turn error remains failed; normal success and existing done+partial tests remain correct. Post-terminal cleanup does not change the outcome.
- [ ] The separate continue action remains available for retriable partial and resumes the existing handle; it does not turn partial into failed or repeat the same diagnostic.
- [ ] `pnpm ci:local` green; delivery notes map the observed incident to the regression and fix.
