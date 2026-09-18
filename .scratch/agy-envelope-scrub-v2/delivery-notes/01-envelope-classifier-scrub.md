# Delivery note: 01 SYSTEM_MESSAGE envelope classifier scrub

**Status:** pending

- Code PR: (fill after claim)
- SHA: (fill)
- Evidence:
  - TDD red: (matrix A/B/C/T failing expectations)
  - TDD green: (vitest paths + counts)
  - `pnpm ci:local`: (fill)
  - Both `translateResult` and `prependHeldBack` paths: (fill)
  - #30 unclosed test rewritten for B4: (fill)
- Residual risk:
  - Fullwidth / lookalike tags (`【SYSTEM_MESSAGE】`) out of scope
  - `<task_notification>` is ticket 02
  - A2 raw Incident A payload may be redacted; cite `om_x100b65e6a11b3cb4b10254b74b00974`
