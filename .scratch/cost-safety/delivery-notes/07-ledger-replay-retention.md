# Delivery note: 07 Ledger retention aligned with the replay window

**Status:** pending (parked)

- Code PR: (fill after claim)
- SHA: (fill)
- Evidence:
  - TDD red: (fill)
  - TDD green: (vitest paths + counts)
  - `pnpm ci:local`: (fill)
  - capacity scenario (5000 newer ids + old in-window @ + failing chat): (fill)
  - hard ceiling value confirmed by owner: (fill)
- Residual risk:
  - Above the hard ceiling backfill stops replaying until load drops (by design: no silent forgetting)
