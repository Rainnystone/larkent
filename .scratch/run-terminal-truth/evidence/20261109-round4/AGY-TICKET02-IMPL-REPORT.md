# Ticket 02 Implementation Report — Discard Antigravity Session After Error Turn

- **Worktree:** `/workspace/rt-agy-fix`
- **Branch:** `work/agy-turn-attribution`
- **Base Commit:** `aabcefe68e148a153f89f57660009bb62ec65b28` (`origin/fix/run-terminal-truth`)
- **Spec / Ticket:** `/workspace/rt-docs/.scratch/run-terminal-truth/issues/02-turn-attribution.md` (Spec D2 in `/workspace/rt-docs/docs/specs/run-terminal-truth.md`)

---

## 1. Commits (`aabcefe6..HEAD`, local only — not pushed)

1. `2af38f62` — `fix(02): clear antigravity scope resume handle on error result`
2. `aa4f6320` — `fix(02): verify antigravity success resume and non-antigravity error session retention`
3. `58114285` — `fix(02): clear turn-journal resumeHandle on antigravity error so continue starts fresh`
4. `fa6661a3` — `fix(02): append new-session line to failure notice when antigravity session is discarded`
5. `7aa0dac6` — `fix(02): address code-review findings on session discard opt-in and turn flow`

---

## 2. Files Changed

- [`src/agent/definition.ts`](file:///workspace/rt-agy-fix/src/agent/definition.ts): Added optional `readonly discardOnError?: boolean` to `AgentMetadata['resume']`.
- [`src/agent/antigravity/metadata.ts`](file:///workspace/rt-agy-fix/src/agent/antigravity/metadata.ts): Declared `discardOnError: true` on `antigravityMetadata.resume` (`{ flag: '--conversation', label: 'session', discardOnError: true }`).
- [`src/agent/antigravity/jsonl.ts`](file:///workspace/rt-agy-fix/src/agent/antigravity/jsonl.ts): Suppressed emitting `this.systemEvents()` inside `translateResult` when `result.status` is `ERROR` or `FAILED`, so a terminal error line never seeds a conversation handle if `init` was absent.
- [`src/bot/run-flow.ts`](file:///workspace/rt-agy-fix/src/bot/run-flow.ts): Updated `recordRunSessionEvent` to clear `SessionStore` (`sessions.clear(scopeId, capability.agentId)`) and archive `SessionCatalog` (`sessionCatalog.archiveActive(...)`) when `event.type === 'error'` and `descriptorFor(capability.agentId).resume.discardOnError` is true, returning a `boolean` indicating whether the session state was mutated.
- [`src/bot/turn.ts`](file:///workspace/rt-agy-fix/src/bot/turn.ts): On settled `outcome.kind === 'failed'`, invoked `recordSession` with the terminal error event to clear `SessionStore`, `SessionCatalog`, and the `TurnJournal` entry's `resumeHandle` (`noteTurnMeta(turnId, { resumeHandle: undefined })`). When an active/started session handle was discarded on error, appended `\n下一条消息将开启新会话。` to the failure `userMessage` (`errorMsg`). Preserved `resumeHandle` on `partial` outcomes (such as retriable print-timeout).
- [`src/bot/comments.ts`](file:///workspace/rt-agy-fix/src/bot/comments.ts): Cleared `docSessionScopeId` in `SessionStore` when `e.type === 'error'` and `descriptorFor(capability.agentId).resume.discardOnError` is true.
- [`tests/integration/session/resume.test.ts`](file:///workspace/rt-agy-fix/tests/integration/session/resume.test.ts): Added integration tests covering `SessionStore` + `SessionCatalog` + `resolveRunResumeHandle` + `startRunFlow` + `buildAntigravityArgs` for `antigravity` `ERROR`, `antigravity` `SUCCESS`, and non-`antigravity` (`claude`) error retention.
- [`tests/integration/bot/run-outcome-stream.test.ts`](file:///workspace/rt-agy-fix/tests/integration/bot/run-outcome-stream.test.ts): Added integration tests covering `继续` continuation after an `antigravity` error and current-turn `antigravity` `ERROR` outcome + new-session failure notice line + fresh next turn.

---

## 3. Acceptance Criteria Coverage

| Acceptance Criterion | Covering Test |
| --- | --- |
| Test: an agy `ERROR` result clears the scope's resume handle (store and catalog), so the next run's argv has no conversation id. | [`tests/integration/session/resume.test.ts`](file:///workspace/rt-agy-fix/tests/integration/session/resume.test.ts#L178-L243) — `clears the scope resume handle in store and catalog on an antigravity ERROR result so the next run argv has no conversation id` |
| Test: an agy `SUCCESS` result keeps resuming the same conversation (no regression). | [`tests/integration/session/resume.test.ts`](file:///workspace/rt-agy-fix/tests/integration/session/resume.test.ts#L245-L299) — `keeps resuming the same conversation on an antigravity SUCCESS result` |
| Test: `继续` after an agy error does not pass the old conversation id. | [`tests/integration/bot/run-outcome-stream.test.ts`](file:///workspace/rt-agy-fix/tests/integration/bot/run-outcome-stream.test.ts#L416-L447) — `does not pass the poisoned conversation id on 继续 after an antigravity error` |
| Test: a non-agy adapter's error keeps its session. | [`tests/integration/session/resume.test.ts`](file:///workspace/rt-agy-fix/tests/integration/session/resume.test.ts#L301-L340) — `keeps a non-antigravity adapter session when an error event is recorded` |
| Test: a current-turn agy `ERROR` still produces a failed outcome (and appends the new-session failure notice line). | [`tests/integration/bot/run-outcome-stream.test.ts`](file:///workspace/rt-agy-fix/tests/integration/bot/run-outcome-stream.test.ts#L449-L482) — `keeps a current-turn antigravity ERROR as a failed outcome and notes that the next message starts a new session` |

---

## 4. Targeted Verification Output

Command:
```bash
git diff --check && pnpm typecheck && pnpm exec vitest run \
  tests/unit/agent/antigravity-jsonl.test.ts \
  tests/unit/agent/capability.test.ts \
  tests/unit/agent/registry.test.ts \
  tests/integration/session/resume.test.ts \
  tests/integration/bot/run-outcome-stream.test.ts \
  --maxWorkers 1 --minWorkers 1
```

Result:
```text
> lark-channel-bridge@0.8.0 typecheck /workspace/rt-agy-fix
> tsc --noEmit

 ✓ tests/unit/agent/antigravity-jsonl.test.ts (59)
 ✓ tests/integration/bot/run-outcome-stream.test.ts (19) 343ms
 ✓ tests/integration/session/resume.test.ts (8)
 ✓ tests/unit/agent/capability.test.ts (9)
 ✓ tests/unit/agent/registry.test.ts (18)

 Test Files  5 passed (5)
      Tests  113 passed (113)
   Duration  3.22s
```

---

## 5. Two-Axis Code Review Findings & Fixes (`7aa0dac6`)

### Standards Axis
1. **Important — Duplicated opt-in flag across `CapabilityShape` and `AgentMetadata['resume']`**:
   - *Finding:* Both `CapabilityShape.discardSessionOnError` and `AgentMetadata['resume']['discardOnError']` were initially added for the same static adapter property.
   - *Fix:* Consolidated onto a single source of truth (`AgentMetadata['resume']['discardOnError']`), matching `resume.flag` and `resume.label`.
2. **Important — Threading `sessionDiscarded` callback alongside `recordSession` through `deliverChatTurn` and `StreamReliability`**:
   - *Finding:* `executeTurn` passed a separate `() => sessionDiscarded` getter through `deliverChatTurn` and `StreamReliability` even though `processAgentStream` already calls `recordSession` directly on `outcome.kind === 'failed'`.
   - *Fix:* Updated `recordRunSessionEvent` and `recordSession` to return `boolean`, allowing `processAgentStream` to read `const sessionDiscarded = outcome.kind === 'failed' && recordSession(...)` directly without extra parameters or `StreamReliability` fields.
3. **Minor — Nested ternary in `tests/integration/session/resume.test.ts` `start()` helper**:
   - *Finding:* `start()` used a nested ternary over `agentKind` instead of `capabilityForProfile(h.profileConfig)`.
   - *Fix:* Replaced with `capabilityForProfile(h.profileConfig)`.

### Spec Axis
1. **Important — Document-comment session scope (`docSessionScopeId`) in `src/bot/comments.ts`**:
   - *Finding:* While `recordCommentSessionEvent` cleared `agentSessionScopeId` via `recordRunSessionEvent` on error, `comments.ts` also writes `docSessionScopeId` directly into `SessionStore` for `resume.label === 'session'` adapters.
   - *Fix:* Cleared `docSessionScopeId` (`sessions.clear(docSessionScopeId, capability.agentId)`) in `src/bot/comments.ts` when `e.type === 'error'` and `resumeMeta.discardOnError` is true.


---

## 6. Review round 2

**Finding (reviewer):** `processAgentStream` in `src/bot/turn.ts` built a fake error event (`{ type: 'error', message: failure.stderrTail || 'agent failed', terminationReason: 'failed' }`) whenever `outcome.kind === 'failed'` but `lastTerminal` was not an error. That threw away the agy session after killed-externally and stderr-only failures, which Spec D2 does not allow.

**Commit:** `8dfbe4d6` — `fix(02): discard agy session only on CLI error result` (local only, not pushed)

### Diff summary
- `src/bot/turn.ts` (+4/−5): removed the fake fallback event. Now the session is discarded only when `outcome.kind === 'failed' && lastTerminal?.type === 'error' && recordSession(lastTerminal)`. If no error terminal arrived, the session is kept and the failure notice has no `下一条消息将开启新会话。` line.
- `tests/integration/bot/run-outcome-stream.test.ts` (+32): new test `keeps the antigravity session when the run fails without a CLI error result`. In the test, an agy run emits `system` (`sess-agy-keep`), then exits 1 with only stderr (`agy exploded`) and no error terminal. The test checks that:
  - the outcome is `failed` and the card terminal is `error`, still showing `agent 失败` (current-turn outcome is unchanged);
  - the rendered output does **not** contain `下一条消息将开启新会话`;
  - the turn-journal entry still has `resumeHandle === 'sess-agy-keep'`;
  - the next message resumes with `resumeHandle === 'sess-agy-keep'`.

### TDD evidence
- **RED** (before the fix): the new test failed with `expected '{"sent":[…]}' not to contain '下一条消息将开启新会话'`. The card showed `⚠️ agent 失败：agent 运行失败\n下一条消息将开启新会话。`, so the stderr-only failure had wrongly discarded the session.
- **GREEN** (after the fix):

```text
$ git diff --check && pnpm typecheck
> tsc --noEmit            # clean

$ pnpm exec vitest run tests/integration/session/resume.test.ts \
    tests/integration/bot/run-outcome-stream.test.ts --maxWorkers 2 --minWorkers 1
 ✓ tests/integration/bot/run-outcome-stream.test.ts (20 tests)
 ✓ tests/integration/session/resume.test.ts (8 tests)
 Test Files  2 passed (2)
      Tests  28 passed (28)
```

The earlier round-1 acceptance tests in these two files still pass: agy ERROR clears the handle, SUCCESS keeps resuming, `继续` after an agy error starts fresh, a non-agy error keeps its session, and a current-turn ERROR still fails with the new-session line.

### Open gap: real runner killed/exit paths (not fixed in this round)
In production, `lastTerminal?.type === 'error'` does **not** fully mean "the CLI result reported ERROR". `src/agent/runner/jsonl-cli-runner.ts` also emits `type: 'error'` events through `translator.fail(...)` when there is no CLI result:
- `killed by SIGKILL` (line 581)
- `exited with code N` (line 592)
- runtime errors (lines 551/555/597)
- missing terminal / no output (lines 601/608)

`AntigravityJsonlTranslator.fail()` builds the same `{ type: 'error', terminationReason: 'failed' }` shape as a translated `result` ERROR. So on the real agy runner, a killed-externally or non-zero-exit run without a `result` line will still discard the session. The new test uses the fake agent, which emits no error terminal, so it does not exercise that runner path.

**Proposed follow-up (needs approval):** the ticket allows "a terminal-event field" for the opt-in. Mark only `translateResult`'s ERROR/FAILED event (for example `fromCliResult: true` on the error `AgentEvent`), and gate the discard on that field instead of `type === 'error'`. Then add a runner-level test for the SIGKILL/exit paths. This touches the shared `AgentEvent` type and about 6 `toEqual` assertions in `tests/unit/agent/antigravity-jsonl.test.ts`.
