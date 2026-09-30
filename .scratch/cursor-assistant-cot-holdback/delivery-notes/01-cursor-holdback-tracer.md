# Delivery note: 01 Cursor assistant CoT hold-back tracer

**Status:** pending

- Code PR: (fill after claim)
- SHA: (fill)
- Evidence:
  - TDD red: (rewritten intermediate-stream + Opus multi-segment+tool fixture failing)
  - TDD green: (vitest paths + counts)
  - `pnpm ci:local`: (fill)
  - tool_call clears pending (no prepend flush): (fill)
  - `final_text` still delivered: (fill)
  - `thinking` still dropped: (fill)
  - multi-round / duplicate / finish(failed) boundaries: (fill)
- Residual risk:
  - Models that put the only user-visible answer *before* the last tool round would lose that segment under clear-on-tool (accepted; matches Grok; final post-tool answer is the contract)
  - Progress-stream UI will show fewer intermediate `text` bubbles for Cursor (intentional)
