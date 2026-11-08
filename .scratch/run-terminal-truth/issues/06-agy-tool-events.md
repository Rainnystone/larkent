# 06: antigravity tool/checkpoint events count as tool activity

**Blocked by:** None · **Status:** ready-for-agent

Evidence (Keeper, read-only): `src/agent/antigravity/jsonl.ts` ~88–101 maps agy tool/checkpoint lines only to liveness, never `tool_use`/`tool_result`, so the idle watchdog's tool grace (`idle-watchdog.ts` ~83–95) never applies to antigravity. Only translated AgentEvents refresh `lastEventAt` (`turn.ts` ~652–654). Live repro 18:45:24 recovery → run `6d94d86b…` killed 18:47:30.

## What to build
First verify from real agy output that tool start and finish signals can be paired by id. Only if they can: map them to `tool_use`/`tool_result` so tool grace applies; keep liveness for the rest. A single liveness line must never be treated as "tool still running". If no pairable signals exist, do not implement; write the finding to delivery notes and stop. No new heartbeat layer.

## Acceptance
- [ ] Test: agy tool running silently > idle limit but < tool grace is not killed; finishes normally.
- [ ] Test: agy tool hung beyond tool grace is still stopped.
- [ ] `pnpm ci:local` green.
