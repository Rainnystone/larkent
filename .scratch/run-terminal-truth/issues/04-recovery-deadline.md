# 04: Recovery deadline ≥ remaining normal idle

**Blocked by:** None · **Status:** ready-for-agent

Spec D5. `src/bot/recovery.ts` (~24–36) and `src/bot/idle-watchdog.ts` (~40–72): after recovery, deadline = max(STALL_AFTER_RECOVERY_MS, remaining normal idle at recovery time). A real agent event restores normal idle timing.

## Acceptance
- [ ] Silent model request spanning a recovery stays alive past 2 min while within normal idle.
- [ ] Real event resets to normal idle timing.
- [ ] A true hang is still stopped by the normal idle limit.
- [ ] `pnpm ci:local` green.
