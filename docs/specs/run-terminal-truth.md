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
- D5 Recovery watchdog: idle and tool budgets count awake time only, never host suspend. Recovery reads the watchdog's remaining budget and may only extend deadlines, never shorten them; it cannot replace an in-flight tool budget with normal idle or a 120-second floor. Disabled idle stays disabled after recovery. Real progress restores normal idle timing; heartbeat-only liveness does not. Use one activity path for chat, agent-task and meeting consumers. Correctness must survive platform timer differences, failed/late sleep probes, repeated sleeps and clock jumps (ticket 04).
  - Host resume is not bridge restart. Grace continuation applies only when the bridge process stays alive across host suspend/resume. On bridge restart, orphan recovery interrupts runs and reaps children (`src/bot/turn-journal.ts:433–455`); do not promise continuation of those budgets across restart.
- D6 Same 继续 must not re-send an already delivered reply when the prior run's text was delivered (covered by D2/D3 fixing the false failure; no new dedupe layer).

## Locked watchdog decisions — 2026-11-08 (Asia/Shanghai)

- **Q1 — Per-tool awake cap:** default tool grace is 60 minutes of awake time from that tool's own start, not a sliding silence window. No event renews that start. Grace must not be shorter than configured normal idle: use `max(60 minutes, normal idle)` when idle is enabled (for 120-minute idle, the per-tool cap is 120 minutes). This configuration floor is the explicit exception to the nominal 60-minute cap. Disabled idle means no watchdog/recovery deadline. Expire unpaired tools rather than granting grace forever; model output after a stale tool returns model-only waits to normal idle (ticket 07).
- **Q2 — No heartbeat extension:** heartbeat/liveness-only events never extend a run. Real text/thinking/tool lifecycle and held-back answer deltas are progress, not status-only pings. Split those meanings instead of ignoring every event named liveness. Progress may refresh normal idle, never an existing tool's absolute cap (tickets 06–07).
- **Q3 — Sub-agent model waits:** a sub-agent waiting on the model uses normal idle. An open parent Task/tool is not proof of a child tool running. Use captured ancestry/phase signals; genuine tools inside a child receive their own grace. Record missing evidence as a gap, not an exception that silently grants model waits 60 minutes (tickets 06–07).

Evidence first for every adapter: capture real redacted events before changing mappings. The agy checked-in fixture is not proof of real output; codex MCP/search/file-change and devin pre-input starts need real verification. Ticket 06 owns that evidence and the all-adapter parametrized test.

## Testing
Unit/integration per ticket; E2E on the test bridge only, Bot Arena, account 「Agent测试专员」, prefix 【端到端测试】. Never touch production bridges.

## Out of scope
printTimeout config (Keeper set 30m; leave it). Webhook plugin (#69). Retry policy of the CLI itself.
