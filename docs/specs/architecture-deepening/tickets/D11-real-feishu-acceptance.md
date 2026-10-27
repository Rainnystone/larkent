# D11 Real Feishu acceptance (Grokbot, operator-run)

Spec: D15, A1, A12. Blocked by: D01 to D10.
Owner: Grokbot. Guide: workspace `feishu-agent-test-guide.md` (test branch / worktree, isolated test data, test bot, real conversations). Code fixes land on `feat/architecture-deepening`.

## Why

The track touches reply delivery, notices, recovery, cards, commands and automations for all seven agent kinds. Integration tests use a recording channel; only a real Feishu run proves A1 (no user-visible change).

## Do

1. Build the exact head of `feat/architecture-deepening` in a test worktree per the guide; record the SHA. Use the test bot and isolated test data only; do not touch live bridges.
2. Run the scenarios below. For each, record pass / fail and a short observation in the code PR's Verification block, with no chat ids, user or bot names, tokens or screenshots containing them.
3. On a failure: reproduce, write a failing test first, fix on `feat/architecture-deepening`, run `pnpm ci:local`, rebuild, restart the test bridge normally, and re-run the failed scenario plus the affected flow. Post `done D11 fix @ <sha>` on the docs PR for each fix.

## Scenarios

| # | Scenario | Coverage |
|---|---|---|
| S0 | Real-CLI smokes (`*_REAL_SMOKE=1` per `tests/process/*-real.smoke.test.ts`) for every kind present; re-capture one D03a scenario per kind and replay it through the shared core | translators still match current CLI versions; record CLI versions and any drift from D03a |
| S1 | One group @ question and one DM question per agent kind (claude, codex, kimi, grok, cursor, antigravity, devin) | one visible answer, Typing reaction added and removed |
| S2 | Reply modes card, markdown, text, CoT on at least two agent kinds (one `stream-deltas`, one `final-answer`) | progress and final rendering unchanged |
| S3 | Stop mid-answer; idle timeout (short `/timeout`) | terminal card and notice wording unchanged |
| S4 | Interrupted turn, then 继续 button, 暂不 button, typed 继续, an ordinary follow-up | continuation semantics unchanged |
| S5 | Network drop or host sleep during a run, then recovery | staged reply redelivered once, no duplicates, backfill of missed @ |
| S6 | Agent creates a reminder via the bridge tool; confirm; it fires | one confirmation card, one reminder message |
| S7 | Agent-created replace / delete; reject one; let one expire | card settles in place, no stray replies |
| S8 | Board pause / resume / delete; `/auto` slash delete | immediate apply for human actions (D3) |
| S9 | Recurring agent task fire | result posted once; failure body unchanged |
| S10 | Slash commands (`/new`, `/cd`, `/config`, `/timeout`) and config / account / workspace card buttons in a group and a DM | behaviour unchanged; group card commands act in group context (D13) |
| S11 | A notice or confirmation button issued by the pre-deploy build, clicked after deploy | existing invalid-click response, once (D1) |
| S12 | Restart the test bridge with a staged reply and a pending draft card | journal v2 / automations upgrade, exactly one delivery each |

## Acceptance

- [ ] S0 to S12 recorded on the code PR; each gap listed as unverified with the reason.
- [ ] Every fix has a regression test and keeps `pnpm ci:local` and CI green.
- [ ] No ids, names or secrets in evidence.
