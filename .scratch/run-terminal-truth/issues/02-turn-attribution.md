# 02: Discard the agy session after an error turn

**Blocked by:** none (01 evidence is in) · **Status:** ready · **Implementer:** local agy on the box, fresh session

Spec D2 (amended 2026-11-09). agy 1.5.3 makes errors sticky: once a turn's `result` is ERROR, later resumed turns in the same conversation still report that error even when they succeed (01 evidence; finding in `delivery-notes/02.md`). There is no reliable current-turn marker, so instead of reclassifying, stop resuming a conversation once it has errored.

## What to build
- When an agy run ends with a CLI `result` of ERROR/FAILED (the translator already sees this, see `src/agent/antigravity/jsonl.ts`), make sure the scope's stored resume handle for that agy conversation does not survive, in both `SessionStore` and `SessionCatalog` (written via `recordRunSessionEvent`, `src/bot/run-flow.ts`, and read via `resolveRunResumeHandle`). The next message in that scope starts a fresh agy conversation, with no `--conversation`.
- The 继续 / continuation path (`src/bot/continuation.ts`, `turn-journal`) must not resume the poisoned conversation id either.
- The opt-in is declared by the antigravity adapter or descriptor (a capability flag or a terminal-event field), not an `agentId === 'antigravity'` check in shared code. Other adapters stay unchanged.
- The current turn's outcome does not change: a genuine error still fails and still renders as it does today. Append one short line to the failure notice saying the next message starts a new session (Chinese, matching existing card wording).
- Don't add any "text + exit 0 means success" heuristic (D1).

## Acceptance
- [ ] Test: an agy ERROR result clears the scope's resume handle (store and catalog), so the next run's argv has no conversation id.
- [ ] Test: an agy SUCCESS result keeps resuming the same conversation (no regression).
- [ ] Test: 继续 after an agy error does not pass the old conversation id.
- [ ] Test: a non-agy adapter's error keeps its session.
- [ ] Test: a current-turn agy ERROR still produces a failed outcome.
- [ ] Local Linux gate (Actions quota exhausted): `git diff --check && pnpm build:web && pnpm exec vitest run --maxWorkers 2 --minWorkers 1 && pnpm typecheck && pnpm build:ci`. The known environment-only failure `proxy.test.ts > eai_again…` (box DNS resolves `.invalid`) is acceptable; any other failure is not. Windows/macOS are marked not run.
- [ ] Live on the test bridge where an agy error can be triggered: a follow-up after an error replies with no `agent 失败`. If no error can be triggered, record that it is unverified live.
