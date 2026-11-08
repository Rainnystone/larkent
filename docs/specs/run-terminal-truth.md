# Spec: run terminal truth (false "agent failed" + recovery 2-min cut)

## Problem
2026-11-08 (Asia/Shanghai), profile `cursor` bot Hakimi (antigravity adapter):
- 17:37:43 the full reply was delivered, then the bridge appended "agent failed" + 继续 card. Clicking 继续 (run `fc65119e…`) reproduced in ~27.6 s and re-sent the same reply. Original run `228bff0d…`.
- Bridge log `~/.lark-channel/profiles/cursor/logs/bridge-20261108.jsonl` 652–658, 681–687: cleanup timeout → SIGTERM → exit 0 → `failed` (`stderr-unclassified`).
- The terminal event the bridge received was `error`, not `done` (`run-executor.ts` 323–337 writes `run/failed` only for `terminalEvent.type=error`; `antigravity/jsonl.ts` 118–126 maps CLI `result.status=ERROR|FAILED` to error). The TCP `streamGenerateContent` timeout text already sits in the session transcript at 12:40:37, long before these runs. Leading hypothesis (unproven, raw result not captured): the CLI reports a historical session error as the current turn's result.
- Separately, 17:33:48: `src/bot/recovery.ts` 24–36 after reconnect backfill forces a 120000 ms deadline (`STALL_AFTER_RECOVERY_MS`) whenever the last event predates the disconnect; `idle-watchdog.ts` 40–53/68–72 then stops the run. The model request issued 17:21:02 was still open and was killed at 17:33:48. Normal idle budget is 900000 ms.

### Additional incident — 19:13 (Asia/Shanghai)

On 2026-11-08, the production `cursor` profile used agy 1.5.3, not the separate `grok` profile. In `~/.lark-channel/profiles/cursor/logs/bridge-20261108.jsonl`, lines 1014–1016 record the resumed run starting at 19:02:34; 1031–1034 record `print timeout after 10m0s` at 19:13:35 and agy's own task-422 list still saying running; 1052–1058 record exit 3, outcome partial, card terminal error, a markdown reply and a separate continue notice. Times are Asia/Shanghai. The later 2-second post-terminal cleanup at 1042–1043 did not cause the original CLI timeout.

The on-disk `~/.lark-channel/config.json:95–101` already said `cursor.agent.options.printTimeout = "30m"` (modified 17:36:08 Asia/Shanghai), but the bridge process had started at 14:03:50 Asia/Shanghai and still used 10m. The CLI log `~/.gemini/antigravity-cli/log/cli-20261108_190234.log:383–387` separately records the timeout and cancellation of step 422. No original stdout NDJSON was found for this run; these logs do not prove whether a task completion event was emitted. Keep the bridge's missing tool-state mapping separate from agy's own background-task bookkeeping (ticket 06).

## Decisions
- D1 Evidence first: capture the redacted raw terminal `result` from the CLI on the test bridge before changing classification. No "has text + exit 0 ⇒ success" rule; a real current-turn error must still fail.
- D2 If D1 confirms historical-error carry-over, fix attribution in the antigravity adapter using a reliable current-turn marker (or the CLI's own per-turn field). If no reliable marker exists, stop and report; do not guess.
- D3 An explicit successful `done` must never be downgraded by a stderr failure signature (`run-outcome.ts` 119–132 currently matches signatures before `done`). Keep the known print-timeout → partial semantics.
- D4 Post-terminal cleanup stays separate from business outcome. Rename log event `post-done-exit-timeout` → `post-terminal-exit-timeout` (it fires for done and error). Default 2000 ms unchanged.
- D5 Recovery watchdog: idle and tool budgets count awake time only, never host suspend. Recovery reads the watchdog's remaining budget and may only extend deadlines, never shorten them; it cannot replace an in-flight tool budget with normal idle or a 120-second floor. Disabled idle stays disabled after recovery. Real progress restores normal idle timing; heartbeat-only liveness does not. Use one activity path for chat, agent-task and meeting consumers. Correctness must survive platform timer differences, failed/late sleep probes, repeated sleeps and clock jumps (ticket 04).
  - Host resume is not bridge restart. Grace continuation applies only when the bridge process stays alive across host suspend/resume. On bridge restart, orphan recovery interrupts runs and reaps children (`src/bot/turn-journal.ts:433–455`); do not promise continuation of those budgets across restart.
- D6 Same 继续 must not re-send an already delivered reply when the prior run's text was delivered (covered by D2/D3 fixing the false failure; no new dedupe layer).

- D7 Configuration and CLI timeout ownership (ticket 08): profile options are captured when the adapter is constructed, not reread on every run (`src/agent/antigravity/adapter.ts:36–40,81–95`). An explicit `/reconnect` reloads config and builds a new adapter (`src/runtime/supervisor.ts:267–293`); link recovery/wake reconnect does not. Make the effective safe configuration visible in logs. Permit explicit `0`/`0s` and omitted `printTimeout` to mean no CLI hard cap, matching installed agy help. In that mode the bridge watchdog owns timing, including awake-time and disabled-idle rules; do not disable the CLI cap until tickets 04, 06 and 07 prove that protection. A fixed whole-turn 60-minute CLI timer is not a per-tool awake-time allowance. The installed help does not specify host-sleep accounting; verify it separately rather than assuming it matches the bridge.
- D8 Partial is not failed (ticket 09): normalize an earlier error state to the settled partial outcome before rendering. Show one print-timeout explanation, not both an appended warning and `agent 失败` for the same event. Keep genuine current-turn failures as failures and keep the separate continue action usable.

## Locked watchdog decisions — 2026-11-08 (Asia/Shanghai)

- **Q1 — Per-tool awake cap:** default tool grace is 60 minutes of awake time from that tool's own start, not a sliding silence window. No event renews that start. Grace must not be shorter than configured normal idle: use `max(60 minutes, normal idle)` when idle is enabled (for 120-minute idle, the per-tool cap is 120 minutes). This configuration floor is the explicit exception to the nominal 60-minute cap. Disabled idle means no watchdog/recovery deadline. Expire unpaired tools at their own awake cap rather than granting grace forever; model output does not cancel an open tool early (Q5, ticket 07).
- **Q2 — No heartbeat extension:** heartbeat/liveness-only events never extend a run. Real text/thinking/tool lifecycle and held-back answer deltas are progress, not status-only pings. Split those meanings instead of ignoring every event named liveness. Progress may refresh normal idle, never an existing tool's absolute cap (tickets 06–07).
- **Q3 — Sub-agent model waits:** a sub-agent waiting on the model uses normal idle. An open parent Task/tool is not proof of a child tool running. Use captured ancestry/phase signals; genuine tools inside a child receive their own grace. Record missing evidence as a gap, not an exception that silently grants model waits 60 minutes (tickets 06–07).
- **Q4 — One watchdog for every task (2026-11-08):** chat, agent-task, meeting and document-comment tasks (`src/bot/comments.ts`) use the same bridge watchdog and budgets. No consumer keeps its own timer or bypasses the shared activity seam (tickets 04, 07).
- **Q5 — Model output does not cancel an open tool:** main-conversation output resets normal idle, but it neither closes a running tool's grace nor extends that tool's awake cap. Only the tool's own verified end, or its cap, closes it. Each tool has its own start, end and fixed cap (ticket 07). This supersedes the earlier "model output after a stale tool returns to normal idle" wording.
- **Q6 — agy background tasks:** they count as tools only if agy 1.5.3 emits real structured start/end signals. Otherwise they are a documented known gap. A live child process is auxiliary diagnostic evidence only, never proof of tool work (tickets 06, 07).
- **Q7 — Early tool signals never skip safety:** opening tool grace on an early start signal must not bypass or reorder the automation policy guard / safety inspection of that tool (tickets 06, 07).
- **Q8 — Timeout wording:** a watchdog stop says the waiting budget was used up, not that the agent was stuck. It names which timer fired (normal idle or tool grace, and which tool) and the awake minutes consumed (tickets 07, 09).
- **Q9 — CLI whole-turn cap default off:** once 04/06/07 are proven, the CLI's own whole-turn cap (agy `--print-timeout`) stays off by default so the bridge owns timing; it is already omitted unless configured (`src/agent/antigravity/argv.ts:61`, `options.ts:27`). Signals that cannot be verified stay a known gap rather than a reason to keep a short CLI cap (ticket 08).

For agy, capture sanitized real NDJSON from the installed 1.5.3 first, and retain a bounded, opt-in, redacted stdout diagnostic capture on the test bridge. Never persist unredacted prompts, credentials or tool payloads.

Evidence first for every adapter: capture real redacted events before changing mappings. The agy checked-in fixture is not proof of real output; codex MCP/search/file-change and devin pre-input starts need real verification. Ticket 06 owns that evidence and the all-adapter parametrized test.

## Testing
Unit/integration per ticket; E2E on the test bridge only, Bot Arena, account 「Agent测试专员」, prefix 【端到端测试】. Never touch production bridges.

## Out of scope
Webhook plugin (#69). Retry policy of the CLI itself. Product changes to agy's own background-task bookkeeping (investigate and report upstream evidence in ticket 06, but do not claim the bridge mapping fixes it). Artifact delivery, file upload and upload size limits do not change this bridge and are not part of this board.

`printTimeout` configuration, effective-config logging and CLI hard-timeout ownership are now explicitly in scope under ticket 08; this supersedes the earlier exclusion. This docs change does not authorize changing or restarting production bridges.
