# 02: Fix current-turn error attribution

**Blocked by:** 01 · **Status:** blocked

Spec D2. Using 01's finding, make the adapter treat only the current turn's error as terminal error. If 01 shows no reliable current-turn marker, do not implement; write the finding to delivery notes and stop.

## Acceptance
- [ ] Historical error + current success ⇒ completed, one reply, no 继续 card.
- [ ] Current-turn real ERROR ⇒ still failed.
- [ ] `pnpm ci:local` green.
