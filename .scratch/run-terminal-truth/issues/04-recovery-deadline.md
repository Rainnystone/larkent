# 04: Recovery deadline ≥ remaining normal idle

**Blocked by:** None · **Status:** ready-for-agent

Spec D5. `src/bot/recovery.ts` (~24–36) and `src/bot/idle-watchdog.ts` (~40–72): after recovery, deadline = max(STALL_AFTER_RECOVERY_MS, remaining normal idle at recovery time). A real agent event restores normal idle timing.

## Acceptance
- [ ] Silent model request spanning a recovery stays alive past 2 min while within normal idle.
- [ ] Real event resets to normal idle timing.
- [ ] A true hang is still stopped by the normal idle limit.
- [ ] `pnpm ci:local` green.

## Added 2026-11-08 18:50 (live evidence from Coder/Keeper)
- [ ] Host sleep/suspend gap is defined explicitly: state in code and test whether wall time spent suspended counts toward idle. The 17:33 kill had ~10m38s of host pause inside a ~15m16s run, so "max(120s, remaining idle)" alone is not proof.
- [ ] Tool in flight across recovery keeps the tool grace (≤60 min), not 120 s.
