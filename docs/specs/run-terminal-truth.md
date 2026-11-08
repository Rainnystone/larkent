# Spec: run terminal truth (false "agent failed" + recovery 2-min cut)

## Problem
2026-11-08 (Asia/Shanghai), profile `cursor` bot Hakimi (antigravity adapter):
- 17:37:43 the full reply was delivered, then the bridge appended "agent failed" + 继续 card. Clicking 继续 (run `fc65119e…`) reproduced in ~27.6 s and re-sent the same reply. Original run `228bff0d…`.
- Bridge log `~/.lark-channel/profiles/cursor/logs/bridge-20261108.jsonl` 652–658, 681–687: cleanup timeout → SIGTERM → exit 0 → `failed` (`stderr-unclassified`).
- The terminal event the bridge received was `error`, not `done` (`run-executor.ts` 323–337 writes `run/failed` only for `terminalEvent.type=error`; `antigravity/jsonl.ts` 118–126 maps CLI `result.status=ERROR|FAILED` to error). The TCP `streamGenerateContent` timeout text already sits in the session transcript at 12:40:37, long before these runs. Leading hypothesis (unproven, raw result not captured): the CLI reports a historical session error as the current turn's result.
- Separately, 17:33:48: `src/bot/recovery.ts` 24–36 after reconnect backfill forces a 120000 ms deadline (`STALL_AFTER_RECOVERY_MS`) whenever the last event predates the disconnect; `idle-watchdog.ts` 40–53/68–72 then stops the run. The model request issued 17:21:02 was still open and was killed at 17:33:48. Normal idle budget is 900000 ms.

## Decisions
- D1 Evidence first: capture the redacted raw terminal `result` from the CLI on the test bridge before changing classification. No "has text + exit 0 ⇒ success" rule; a real current-turn error must still fail.
- D2 If D1 confirms historical-error carry-over, fix attribution in the antigravity adapter using a reliable current-turn marker (or the CLI's own per-turn field). If no reliable marker exists, stop and report; do not guess.
- D3 An explicit successful `done` must never be downgraded by a stderr failure signature (`run-outcome.ts` 119–132 currently matches signatures before `done`). Keep the known print-timeout → partial semantics.
- D4 Post-terminal cleanup stays separate from business outcome. Rename log event `post-done-exit-timeout` → `post-terminal-exit-timeout` (it fires for done and error). Default 2000 ms unchanged.
- D5 Recovery watchdog: the post-recovery deadline must be no earlier than the normal idle deadline still remaining at recovery time; a real agent event returns to normal idle timing; a true hang is still stopped by the normal idle limit.
- D6 Same 继续 must not re-send an already delivered reply when the prior run's text was delivered (covered by D2/D3 fixing the false failure; no new dedupe layer).

## Testing
Unit/integration per ticket; E2E on the test bridge only, Bot Arena, account 「Agent测试专员」, prefix 【端到端测试】. Never touch production bridges.

## Out of scope
printTimeout config (Keeper set 30m; leave it). Webhook plugin (#69). Retry policy of the CLI itself.
