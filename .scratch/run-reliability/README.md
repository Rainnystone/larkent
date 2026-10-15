# Dual-track: run reliability

Docs track for lost-message fixes, the RunOutcome model, CLI signature table, turn journal, interruption notice and the isolated test bridge.

Grill closed (Opus 5.5 high review, 2026-10-15; product decisions locked in Spec §4). Spec: [docs/specs/run-reliability.md](../../docs/specs/run-reliability.md).

Tickets below are tracer-bullet slices of that Spec. They are not product code.

## Tracks

| Track | Branch | PR | What it may contain |
| --- | --- | --- | --- |
| Docs (this) | `docs/run-reliability` | **[#40](https://github.com/Rainnystone/larkent/pull/40)** (draft) | Spec, tickets, this README, CONTEXT.md / agent-setup.md edits, delivery-note placeholders |
| Code | `feat/run-reliability` | **[#39](https://github.com/Rainnystone/larkent/pull/39)** (draft) | Product code + tests only (opened empty) |

Do **not** merge this docs PR as a substitute for the feat PR. Do **not** copy `.scratch/` or the Spec onto the feat branch.

## Prerequisite (user / Coder, not an implementer task)

Baseline the live working tree's uncommitted `src/bot/channel.ts` / `src/bot/keepalive.ts` changes into a commit or branch before any ticket lands. See Spec §8.

## Blocking graph

```
0a-hard-access-fence
        │
        ▼
0b-test-bridge ──(redelivery experiment result)──▶ 1-lost-message
                                                        │
                                                        ▼
                                                  2-run-outcome
                                                        │
                                                        ▼
                                                  5-cli-signatures
                                                        │
                                                        ▼
                                                  4-turn-journal
                                                        │
                                                        ▼
                                                  3-interruption-notice
```

Parallel start set: none (0b delivered; ticket 1 still waits on the live redelivery experiment).

## How an implementer claims a ticket

1. Read the Spec, then **one** ticket whose blockers are all delivered.
2. Claim it on docs PR #40 (comment or edit Status).
3. Work on the code branch `feat/run-reliability` (#39), not this docs branch.
4. Red tests first, then green, then `pnpm ci:local`. Push only to the code PR.
5. Fill the matching delivery note here.

## Tickets

| Order | # | Path | Title | Blocked by | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | 0a | [issues/0a-hard-access-fence.md](issues/0a-hard-access-fence.md) | Hard access fence, machine-level app lock, live-root guard | None | delivered (`a5613bc`) |
| 2 | 0b | [issues/0b-test-bridge.md](issues/0b-test-bridge.md) | Isolated test bridge + deterministic vitest layer | 0a | delivered (`d1975e7`; live redelivery experiment still pending credentials) |
| 3 | 1 | [issues/1-lost-message.md](issues/1-lost-message.md) | Lost-message fix (all paths) | 0b | blocked |
| 4 | 2 | [issues/2-run-outcome.md](issues/2-run-outcome.md) | RunOutcome model + stop reason | 1 | blocked |
| 5 | 5 | [issues/5-cli-signatures.md](issues/5-cli-signatures.md) | CLI signature table, golden stderr, redaction, bounded stderr | 2 | blocked |
| 6 | 4 | [issues/4-turn-journal.md](issues/4-turn-journal.md) | Turn journal | 2, 5 | blocked |
| 7 | 3 | [issues/3-interruption-notice.md](issues/3-interruption-notice.md) | Interruption notice card | 4 | blocked |

## Evidence rules

- CI: vitest under `tests/` (+ `e2e/test-bridge` deterministic layer).
- Test bridge evidence: redacted; no app id, chat id, open id, token or secret in any committed file or PR text. Real values live in gitignored `e2e/.local/`.
- Never touch live bridges or the live data root while testing.
