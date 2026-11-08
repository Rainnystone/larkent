# 08: Config takes effect + CLI hard-timeout ownership

**Blocked by:** 04, 06, 07 · **Status:** blocked

Read Spec D5, D7 and Q1–Q3. References are from docs-track commit `b8adcd46`; follow the named functions if lines move. This ticket changes bridge behavior on the code track, not the live bridge configuration. Do not restart production or edit its config.

## Why

The 2026-11-08 19:13:35 incident (Asia/Shanghai) hit agy's 10-minute print timeout even though the disk config had been changed to 30 minutes at 17:36:08. The cursor bridge had been running since 14:03:50. See Spec's additional incident and production log `~/.lark-channel/profiles/cursor/logs/bridge-20261108.jsonl:1031–1034`.

`src/runtime/profile-runtime.ts:145–167` reads the root config/profile. `src/runtime/agent-runtime.ts:35–37` constructs its adapter. `src/agent/antigravity/adapter.ts:36–40` saves profile options; `:81–95` merges that saved snapshot for each run, and `src/agent/antigravity/argv.ts:59–61` passes `--print-timeout`. Editing the file alone does not update that snapshot. `/reconnect` and `/account` use the explicit reload/rebuild path (`src/runtime/supervisor.ts:267–293`); a network recovery or wake reconnect does not.

## What to build

Make this boundary explicit and observable, not a surprise. Log the profile, agent kind, config path, effective print-timeout mode/value and bridge idle/tool timing at adapter creation and run start, including after explicit reload. Use an allowlist of safe fields: never dump config, argv, prompts or credentials. Distinguish configured CLI cap from no CLI cap and from bridge idle being disabled. Do not add automatic hot reload or restart active runs.

Installed agy 1.5.3 `--help` says `--print-timeout` defaults to `0s`; `0` waits until the turn completes. Let `printTimeout` be omitted or explicitly `"0"` / `"0s"` for no CLI cap. `src/agent/antigravity/options.ts:50–63,85–89` currently requires a positive duration and rejects zero. Keep positive-duration validation and antigravity-only option boundaries. Verify the actual argv for omitted, zero and positive values against this CLI's help.

With no CLI cap, the bridge watchdog owns elapsed-time policy: per-tool awake grace, normal model idle and disabled-idle behavior. Complete the 04/06/07 protection before choosing this mode. A 60-minute whole-turn CLI timer cannot guarantee 60 awake minutes for a tool that starts late. Do not claim agy's own timer excludes host sleep: help does not specify this; record a safe test or authoritative documentation, otherwise leave it unverified. This ticket is not a change to agy's retry policy.

## Acceptance
- [ ] A safe fixture proves a disk edit does not change an existing adapter, while explicit `/reconnect` reload creates an adapter using the new value; network/wake recovery does not pretend to reload configuration.
- [ ] Startup/run logs show effective safe timing configuration and the correct profile/config path; tests prove credentials and prompts are absent.
- [ ] Omitted, `"0"`, `"0s"` and positive durations have tested parse/argv behavior; invalid/negative durations remain rejected and other adapters do not accept this option.
- [ ] With no CLI cap, the verified bridge watchdog still stops model silence and unpaired tools at the agreed awake budgets. Disabled idle remains deliberately disabled; heartbeat-only events cannot extend a run. No production config is changed as part of this verification.
- [ ] CLI timer sleep behavior is verified separately or explicitly marked unverified; no claim that a fixed CLI cap equals per-tool awake grace.
- [ ] `pnpm ci:local` green; delivery notes record effective config/reload evidence and exact tests.
