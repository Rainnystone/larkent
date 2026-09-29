# Delivery note: 01 Backfill self-echo tracer

**Status:** pending

- Code PR: (fill after claim)
- SHA: (fill)
- Evidence:
  - TDD red: (app-id self / p2p app / echo-chain tests failing on master)
  - TDD green: (vitest paths + counts)
  - `pnpm ci:local`: (fill)
  - app id wiring in `channel.ts`: (fill)
  - group regression (human @bot, other-app with/without @): (fill)
  - ledger / deleted / slash skips unchanged: (fill)
- Residual risk:
  - Own replies are still not in the ledger (D3); protection relies on sender identity only
  - p2p `sender_type === 'app'` blanket skip assumes p2p chats never contain another app (accepted per D2)
