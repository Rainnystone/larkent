# Architecture deepening (Spec)

Status: ready for tickets. Docs track: `docs/architecture-deepening` (never merged). Code track: `feat/architecture-deepening`.
Base: `master @ d0a25868`. Vocabulary: `CONTEXT.md` for the domain; module / interface / depth / seam / adapter / leverage / locality as in mattpocock `codebase-design`.

## 1. Problem

Change concentrates in a few places, and each fix there spreads across many files because the rule being fixed has no single owner.

| Hot spot (last 400 commits) | Commits | What hurts |
|---|---|---|
| `src/bot/channel.ts` (3759 lines) | 124 | Reply delivery, outbox sweep, notices, automations wiring and the run pipeline are private functions. 66 test files reach them only through `startChannel`. |
| `src/automations/store.ts`, `command.ts` | 39, 34 | The draft confirmation card is an implicit state machine written by six files. Recent draft-card fixes touch 4 to 8 files each (`fece31b7`, `ae9f4906`, `5f4385b7`, `af604f73`). |
| `src/agent/*/jsonl.ts`, `devin/transcript.ts` | 16 (grok) | Six final-answer translators each re-implement answer hold-back, flush, dedup and drift bookkeeping. Hold-back fixes landed per agent (`1cea9004`, `799fb263`, `b9e80284`, `06098c63`, `634c6ff2`). |
| `src/card/dispatcher.ts`, `src/commands/index.ts` | 28, 28 | Four hand-written HMAC token modules with diverged nonce rules; two ~25-field context objects assembled twice; a hard-coded if-chain per button family. |

Four separate implementations of "send a bot message durably" exist today:

1. Final reply and notice: `channel.ts` `deliverFinalReply` / `settleStreamDelivery` / `sendOrWait` / `recordSend` / `resendJournalReply` / `recallReplacedMessage` / `sendTurnNotice`, plus the sweep timer (`channel.ts:801-857`).
2. Automation reminder: `src/automations/delivery.ts:126-190` stages on the turn journal and redelivers with its own classify branch.
3. Draft card: `src/automations/draft-delivery.ts` keeps its own `prepared` / `sending` / `rejected` state in `automations.json` and its own readback.
4. Interruption notice stage / send / resend: `src/bot/interruption-notice.ts:275-420`, called from `channel.ts:3464-3530`.

`RunOutcome` is described as "the unique end classification" but is derived in three places: `src/runtime/run-executor.ts:347`, `src/bot/channel.ts:3163` and `3194`, `src/automations/agent-run.ts:535`.

The agent run loop exists twice. `src/automations/agent-run.ts:490-550` re-implements `channel.ts` `processAgentStream` almost line for line (system → watchdog arm, `shouldDeliverAgentEvent`, `noteDelivered`, terminal tracking, `reduce`, `deriveRunOutcome`, outcome applied to state), then `finalReplyFor` + `renderText`. The copies have already drifted: the automation fire derives its outcome without `outageOverlapped`.

Translators keep the bot's idle watchdog alive by emitting an empty `{ type: 'system' }` (`grok/jsonl.ts:118`, `devin/transcript.ts:22`), a contract that lives only in a comment. Open tool calls are tracked twice: inside every translator and again in `src/bot/idle-watchdog.ts`.

## 2. Goal

Deepen six modules so each rule has one owner and one test surface, without changing what a Feishu user sees:

1. **Outbox**: the only path for a bot-initiated durable message.
2. **Agent event contract**: answer hold-back, liveness and tool pairing owned once on the adapter side.
3. **Run outcome**: derived once per run.
4. **Action token** and **user action entry**: one token codec; slash commands and card actions resolve to registered actions.
5. **Draft confirmation** and **automation mutation**: the confirmation card lifecycle and the mutation policy each live in one module.
6. **Turn execution**: one module runs an agent turn from run options to a delivered final state, shared by chat batches and automation agent fires.

## 3. Decisions (locked with the owner)

- **D1 Compatibility boundary.** Preserve user-visible behaviour only. Persistence formats may change: bump `schemaVersion`, upgrade atomically in the loader, never drop user data, keep refusing future versions (CONTEXT.md › Persistence rules). Card action token wire formats may change. Buttons issued before the deploy then get the existing invalid-click response once; that is accepted.
- **D2 Unsigned buttons stay fence-only.** `config.*`, `account.*` and `ws.*` card actions keep relying on the access fence. The user action registry declares this explicitly per action; nothing is fence-only by omission.
- **D3 Mutation confirmation is decided by actor.** A human acting directly (slash command, board button) applies immediately. The model acting through a bridge tool goes through a confirmation card. This is today's behaviour; it becomes one stated policy instead of three call sites.
- **D4 One Outbox.** Final replies, interruption notices, automation reminders and results, and draft cards are Outbox items. Each item has a stable `deliveryId` used as the Feishu `uuid`, per-item state (`staged`, `sent`, `rejected`, `voided`), a receipt, an optional `supersedes` id to recall, and a kind-specific receipt hook (for example, a draft card binds its message id to the draft). The existing semantics in CONTEXT.md › outbox (one `classify`, link-down staging, uuid window, readback outside the window, card patch for a failed final stream) are kept verbatim; only their owner changes.
- **D5 Outbox persistence keeps turn state and its items atomic.** Outbox items live in the turn journal file, so staging a reply and settling its turn remain one atomic write. The journal schema bumps to v2 with items keyed by `deliveryId`; the turn entry references its reply and notice items. Draft-card delivery state moves out of `automations.json` into Outbox items (D1 permits the migration).
- **D6 Hold-back stays on the adapter side.** Per the closed devin double-reply spec (PR #58), channel-side dedupe is rejected. One shared final-answer core in `src/agent/` owns answer accumulation, pre-tool segment classification, dedup, terminal emission and drift bookkeeping. Each adapter maps raw protocol records to a small set of inputs and declares its policy differences (for example, cursor discards pre-tool text, grok keeps the last segment as a fallback, antigravity scrubs envelopes before `final_text`).
- **D7 Liveness is an explicit event.** `AgentEvent` gains a liveness variant. Any event re-arms the idle bound; no translator emits an empty `system` record for liveness. `system` carries session metadata only.
- **D8 Tool pairing is guaranteed by the contract.** The shared core guarantees every `tool_result` follows its `tool_use` and every open call is closed or failed at terminal. The idle watchdog is the only open-call tracker in the bot.
- **D9 Run outcome has one owner.** The executor derives `RunOutcome` once when the run settles, with outage overlap read through an injected getter, and stores it on the run handle. Channel, cards, notices, logs and automation fires read `handle.outcome`.
- **D10 One action token codec.** One module signs and verifies `PREFIX.payload.hmac` tokens, parameterized by purpose and a nonce policy (`none`, `consume-on-verify`, `deferred`). Key rotation and TTL live there. Callers keep only their claims shape.
- **D11 One user action entry.** A slash command and a card click both resolve to a registered action with a declared auth requirement (`signed(purpose)` or `fence-only`) and one invalid-click response per surface. Card-originated commands keep the real chat type of the clicked chat.
- **D12 Ground truth over guesses.** All seven CLIs are installed on the owner's machine (codex-cli 0.163.0, grok 1.0.71, claude 2.1.283, agy 1.4.4, devin 3000.11.92, cursor-agent 2026.09.08, kimi 2.1.1; lark-cli 1.0.98). Agent protocol behaviour that a ticket relies on comes from transcripts captured from these binaries, not from memory or docs. Feishu API behaviour stays as today; a ticket that needs a new Feishu assumption verifies it with `lark-cli` against the test bot per the workspace `feishu-agent-test-guide.md`, and records the evidence.
- **D13 Bugs found on the way are fixed in the ticket that touches them**, each with a regression test, and listed in that ticket's delivery note. Known now: `src/card/dispatcher.ts:629` builds card-originated command messages with a hard-coded `chatType: 'p2p'`; the automation agent fire derives its outcome without outage overlap (fixed structurally by D05 / D10).
- **D14 Turn execution has two callers, so it is a real seam.** The module owns: run the agent through the executor, consume the event stream, the idle watchdog, read `handle.outcome` (D05), produce the final run state, and hand the reply to the Outbox. Callers own their inputs: chat batches keep media, quotes, topic context, resume / continuation and prompt building; automation fires keep task text, a fresh session and the policy-guard (a hook the module calls on `tool_use`). This is not a mechanical file split of `runAgentBatch`; it lands after D01, D02, D04 and D05 so its seams come from the code those tickets leave behind.
- **D15 Real Feishu acceptance is operator-run by Grokbot** per the workspace `feishu-agent-test-guide.md`, after all code tickets. Issues it finds are fixed test-first on `feat/architecture-deepening`.

## 4. Non-goals

- Unifying card-update transports (`managed.ts`, `cardkit-update.ts`, board sequence) beyond what a ticket needs.
- Splitting `AutomationsStore` into facades, except where D5 moves draft delivery out.
- Any new user-facing feature, wording or layout change.

## 5. Testing

- **The interface is the test surface.** Each deepened module gets tests through its own interface: Outbox with a real turn journal on a temp file and `tests/helpers/recording-lark-channel.ts`; the shared final-answer core with captured transcripts; the action token codec and user action registry in-process; draft confirmation with a temp `AutomationsStore`, a real Outbox and a recording channel; turn execution with a scripted agent adapter (D03 transcripts), a real executor, a real Outbox and a recording channel, exercised once per caller (chat batch, automation fire).
- **Replace, don't layer.** When a module's own tests cover behaviour that was previously only reachable through `startChannel`, delete the now-redundant internal-detail assertions. Keep `startChannel` tests that pin user-visible behaviour.
- **Characterize first.** Before moving code, the ticket adds or confirms a red-on-change test of the current user-visible behaviour, then moves the code with that test green throughout.
- **Captured transcripts (D12).** Golden JSONL / ACP transcripts for all seven CLIs live under `tests/fixtures/transcripts/<kind>/`. Scenarios: answer only; narration, tool, answer; two tools in one turn; a long-running tool; user stop mid-answer; an unknown model or auth error where the CLI produces one. Each file header records CLI version, capture date and the exact command, with no account names, ids or tokens.
- **Crash ordering for the Outbox.** Tests kill between stage and send, between send and receipt, and during recall, then recover and assert exactly one visible message.
- **Gate.** `pnpm ci:local` in the worktree; CI green on the code PR head.

## 6. Acceptance

- A1 No user-visible change in reply, notice, reminder, confirmation card, board or command behaviour across the seven agent kinds and the card / markdown / text / CoT reply modes, as pinned by the integration suite.
- A2 One Outbox implementation; no Feishu send-with-classify logic remains in `channel.ts`, `automations/delivery.ts`, `automations/draft-delivery.ts` or `interruption-notice.ts`.
- A3 Journal v1 and automations v2 files with staged items upgrade atomically and redeliver once after restart.
- A4 One shared final-answer core; translators contain no pending-text, flush or drift bookkeeping of their own; no empty `system` liveness events; captured transcripts for all seven CLIs replay green.
- A5 `deriveRunOutcome` is called from exactly one production site.
- A6 One token codec; no other module calls `createHmac` for card actions.
- A7 Every card action and slash command resolves through the registry with a declared auth requirement; `dispatcher.ts` keeps no per-family if-chain.
- A8 Draft card state is opaque outside the draft confirmation module; the mutation policy (D3) is stated in one module and the scheduler carries no operation semantics.
- A9 `CONTEXT.md` updated for Outbox, liveness, answer hold-back, action token and user action.
- A10 `pnpm ci:local` passes and CI is green on the code PR head.
- A11 Chat batches and automation agent fires run through one turn execution module; no second agent event loop remains in `src/automations/`; `runAgentBatch` keeps only chat-specific input preparation.
- A12 Grokbot's real Feishu acceptance evidence (D11 scenarios) is recorded on the code PR without ids or names, or each gap is listed as unverified.
