# Delivery note: 02 Persistent per-chat failure isolation

**Status:** pending

- Code PR: (fill after claim)
- SHA: (fill)
- Evidence:
  - TDD red: (400-every-run window stays incomplete on master)
  - TDD green: (vitest paths + counts)
  - `pnpm ci:local`: (fill)
  - 4xx vs 5xx / network / status-less split: (fill)
  - warn log `chatId` + `status`: (fill)
  - short-gap skip restored on next run: (fill)
- Residual risk:
  - A 4xx that is actually transient (e.g. 429 if classified non-retryable) would drop that chat's catch-up for one window
  - A chat that 4xx's on history fetch misses catch-up for that window (accepted per D6)
