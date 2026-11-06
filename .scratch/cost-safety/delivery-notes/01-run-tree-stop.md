# Delivery note: 01 Run-tree stop

**Status:** pending (parked)

- Code PR: (fill after claim)
- SHA: (fill)
- Evidence:
  - TDD red: (fill)
  - TDD green: (vitest paths + counts)
  - `pnpm ci:local`: (fill)
  - CI matrix (macOS / Ubuntu / Windows) for the flipped descendant test: (fill)
  - stop paths covered (stop / interrupt / stopAll / idle / shutdown): (fill)
  - identity check (mismatched start time not signalled): (fill)
- Residual risk:
  - Work that leaves the process group (`setsid`, double fork, daemons, remote jobs) is not stopped (Spec D1, known limitation)
  - Windows mechanism chosen (job object vs `taskkill /T`): (fill)
