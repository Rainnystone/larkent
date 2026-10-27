# Architecture deepening: handoff

Start here, then read `docs/specs/architecture-deepening.md` and `tickets/README.md`.

## Goal

Give each of five rules one owner and one test surface (Outbox, agent event contract, run outcome, action token + user action entry, draft confirmation + mutation policy) without changing what a Feishu user sees. Origin: an `improve-codebase-architecture` review of `master @ d0a25868`; decisions D1 to D13 were locked with the owner.

## State

- Spec and tickets D01 to D09: ready. Implementation starts only after the owner approves the Spec on this PR.
- Code track: `feat/architecture-deepening` (draft code PR). One code PR collects every ticket commit; no PR per ticket.
- Out of scope: `runAgentBatch` split, real Feishu acceptance (recorded as unverified in the code PR).

## How to claim

```bash
git fetch origin docs/architecture-deepening feat/architecture-deepening
git show origin/docs/architecture-deepening:docs/specs/architecture-deepening.md
git show origin/docs/architecture-deepening:docs/specs/architecture-deepening/tickets/README.md
git show origin/docs/architecture-deepening:docs/specs/architecture-deepening/tickets/<Dnn>-<name>.md
```

- Comment `claiming Dnn` on the docs PR; finish with `done Dnn @ <sha>` plus the delivery note (README › Rules).
- Frontier tickets (D01, D03, D06) may run in parallel, each in its own worktree on `feat/architecture-deepening-dNN` branched from `feat/architecture-deepening`. The integrator merges them back with normal merges in the README's integration order and re-runs `pnpm ci:local` after each merge.
- All other tickets run on `feat/architecture-deepening` after their blockers are merged.
- Normal commits. No force-push, squash, or rebase of pushed commits. Do not copy Spec or ticket files into the code branch.
- Workers do not mark the code PR ready, request reviews, merge, deploy, or restart live bridges.

## Navigation

| Area | Read first | Targeted tests |
|---|---|---|
| Outbox (D01, D02) | `CONTEXT.md` › outbox, turn journal; `src/bot/channel.ts` 801-857 and 2416-3100; `src/bot/turn-journal.ts`; `src/bot/feishu-delivery.ts`; `src/automations/delivery.ts`; `src/automations/draft-delivery.ts` | `pnpm test:integration`; files listed in D01 / D02 |
| Agent events (D03, D04) | `CONTEXT.md` › Agents; `src/agent/types.ts`; `src/agent/*/jsonl.ts`; `src/agent/devin/transcript.ts`; `src/bot/idle-watchdog.ts` | `pnpm test:process`; `tests/unit/agent/*`; opt-in `*_REAL_SMOKE=1` |
| Run outcome (D05) | `src/bot/run-outcome.ts`; `src/runtime/run-executor.ts` | files listed in D05 |
| Tokens and actions (D06, D09) | `src/card/dispatcher.ts`; `src/commands/index.ts`; the four auth modules | `tests/unit/card/*`; `tests/integration/card/*`; `tests/static/contracts.test.ts` |
| Automations (D07, D08) | `CONTEXT.md` › automations; `src/automations/command.ts`; `store.ts`; `scheduler.ts` | `pnpm exec vitest run tests/unit/automations tests/integration/bot/auto-*.test.ts tests/integration/bot/reminder-tools` |

Full gate: `pnpm ci:local`. CI must be green on the code PR head (`gh pr checks`).

## Ground truth (D12)

All seven CLIs and `lark-cli` are installed on the owner's machine. Do not infer agent protocol behaviour; use the D03 transcripts or capture more. Do not infer new Feishu behaviour; verify with `lark-cli` against the test bot per the workspace `feishu-agent-test-guide.md`. Real-CLI captures and smokes spend quota and run only on the owner's machine.
