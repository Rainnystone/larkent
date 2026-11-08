# 03: done never downgraded by stderr signature; log rename

**Blocked by:** None · **Status:** ready-for-agent

Spec D3, D4. In `src/bot/run-outcome.ts` (~119–142) evaluate an explicit `done` terminal before stderr failure signatures, keeping print-timeout → partial. Rename `post-done-exit-timeout` → `post-terminal-exit-timeout` in `src/runtime/run-executor.ts` (~239–259) and any docs/tests referencing it.

## Acceptance
- [ ] done + matching stale stderr signature ⇒ completed.
- [ ] error + exit 0 ⇒ failed; print-timeout ⇒ partial unchanged.
- [ ] done, child hangs >2 s, SIGTERM, exit 0 ⇒ completed, reply sent once, process slot released; cleanup failure still reported.
- [ ] `pnpm ci:local` green.
