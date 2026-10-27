# Architecture deepening tickets

Spec: `docs/specs/architecture-deepening.md`. Handoff: `docs/specs/architecture-deepening/HANDOFF.md`.
Read this README (shared interfaces and invariants) and the ticket before starting. Never dispatch on a ticket title alone.

## Status

| # | Ticket | Blocked by | Status |
|---|---|---|---|
| D01 | Outbox owns reply and notice delivery | none | ready |
| D02 | Reminders and draft cards become Outbox items | D01 | ready |
| D03 | Capture real transcripts for seven CLIs | none | ready |
| D04 | Shared final-answer core, liveness event, tool pairing | D03 | ready |
| D05 | Run outcome derived once | D01, D04 | ready |
| D06 | One action token codec | none | ready |
| D07 | Draft confirmation module | D02, D06 | ready |
| D08 | Automation mutation policy in one module | D07 | ready |
| D09 | One user action entry for commands and card actions | D06, D07 | ready |
| D10 | Turn execution module (chat batches + automation fires) | D01, D02, D04, D05 | ready |
| D11 | Real Feishu acceptance (Grokbot, operator-run) | D01-D10 | ready |

Frontier: D01, D03, D06 (parallel in separate worktrees). Then D02 and D04, then D05 and D07, then D08, D09 and D10, then D11.
Suggested integration order into `feat/architecture-deepening`: D03 → D06 → D01 → D04 → D02 → D05 → D07 → D08 → D09 → D10 → D11.

## Shared interfaces and invariants

- **Outbox** (D01, D02). Interface, in words: stage an item (kind, target chat / thread / reply-to, payload, `deliveryId`, optional `supersedes`); deliver it now if the link is up; redeliver staged items on Recovery and on the bounded sweep; void items for a scope. Every item kind supplies how to render its payload and an optional receipt hook. Callers never call `classify`, `withDeliveryUuid`, `redeliverStagedReply` or `channel.send` for a durable message themselves.
- **Outbox semantics are frozen.** One `classify` (link / rejected / local); while the link is down, stage and return; Recovery delivers and stops at the first link error; the sweep retries staged rejected / local replies only while the link is up; the `deliveryId` is the Feishu `uuid`; trust only the returned `message_id`; outside the 1-hour uuid window, read back by `parent_id` + bot app id + `create_time`; a failed final stream with a known card receipt is patched in place; a gone card falls back to one uuid-keyed send. Source: `CONTEXT.md` › outbox.
- **Persistence (D1, D5).** Turn journal schema v2 holds Outbox items keyed by `deliveryId`; turn entries reference their items. The v1 loader upgrade is atomic and preserves staged items so they redeliver once. `automations.json` drops draft delivery fields in a schema bump; in-flight `prepared` / `sending` draft deliveries migrate to Outbox items. Future versions are refused without replacing the original.
- **AgentEvent contract** (D04, D05). `system` carries session metadata only (resume handle, model). A new liveness variant means "still alive, render nothing". `tool_use` / `tool_result` are paired by the shared core; terminal closes or fails every open call. Final-answer agents emit `final_text` once at a successful end; progress `text` only for pre-tool narration their policy keeps.
- **Run outcome** (D05). Derived once at settlement by the executor; `handle.outcome` is the only read path.
- **Action token** (D06). `sign(purpose, claims, ttl)` / `verify(token, purpose, context)` returning typed claims or a typed invalid reason. Nonce policy per purpose: `none`, `consume-on-verify`, `deferred` (verify, then claim / release / consume explicitly). Purposes today: bridge callback, interruption notice, automation confirm, automation board.
- **User action registry** (D09). Each action declares its auth (`signed(purpose)` or `fence-only`), its handler and its invalid response. `config.*`, `account.*`, `ws.*` are declared `fence-only` (D2).
- **Turn execution** (D10). Input: run options, a delivery target, optional hooks (policy-guard on `tool_use`). Output: a delivered final run state with `handle.outcome`. Owns executor call, event loop, idle watchdog, progress stream and handoff to the Outbox. Callers own input preparation.
- **Mutation policy** (D08). Human direct (slash, board) applies immediately; model via tool goes through a confirmation card (D3).
- **Ground truth** (D12). Protocol claims cite a captured transcript under `tests/fixtures/transcripts/<kind>/`. New Feishu assumptions cite `lark-cli` evidence from the test bot.

## Rules for every ticket

- One ticket = one fresh session. Work in a worktree on `feat/architecture-deepening` (or a `feat/architecture-deepening-dNN` branch off it for frontier tickets, merged back by the integrator with a normal merge).
- Red → green → refactor. Start with a meaningful failing test on external behaviour, or a characterization test that pins today's user-visible behaviour before code moves.
- Replace, don't layer: delete tests that only pinned moved internals once the module's own interface tests cover them. Keep user-visible `startChannel` tests.
- Fix bugs found on the way in the same ticket with a regression test; list them in the delivery note (D13).
- Update `CONTEXT.md` for any term the ticket introduces or redefines.
- Done = targeted tests green, `pnpm ci:local` green in the worktree, `/code-review` (Standards + Spec) clean, delivery note posted on the docs PR as `done Dnn @ <sha>` with what changed, what was deleted, bugs fixed and anything unverified.
- Public repo: no Feishu ids, chat ids, account or bot names, tokens or secrets in code, fixtures, commits or PR text.
