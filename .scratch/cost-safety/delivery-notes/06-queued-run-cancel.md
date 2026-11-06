# Delivery note: 06 Queued runs cancellable

**Status:** pending (parked)

- Code PR: (fill after claim)
- SHA: (fill)
- Evidence:
  - TDD red: (fill)
  - TDD green: (vitest paths + counts)
  - `pnpm ci:local`: (fill)
  - interrupt / stopAll / expiry / pause cases (ProcessPool(1), fake adapter): (fill)
- Residual risk:
  - Debounce queue cancellation is unchanged (PendingQueue.cancelAll)
