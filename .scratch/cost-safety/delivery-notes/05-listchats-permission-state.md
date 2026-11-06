# Delivery note: 05 listChats permission-needs-action

**Status:** pending (parked)

- Code PR: (fill after claim)
- SHA: (fill)
- Evidence:
  - TDD red: (fill)
  - TDD green: (vitest paths + counts)
  - `pnpm ci:local`: (fill)
  - 403 / 401 / 429 / 5xx / status-less split: (fill)
  - re-probe cadence confirmed by owner: (fill)
  - window preserved and replayed once after restore: (fill)
- Residual risk:
  - History older than the lookback at restore time is not replayed (lookback clamp, unchanged)
