# Spec: Backfill self-echo (bot re-answers its own replies)

Status: ready-for-agent (docs track). Grill closed by product owner (locked 2026-09-29). Do not reopen locked decisions.
Written 2026-09-29 from bridge-log evidence on profiles `cursor` (agy bot) and `grok` after PR #34 (p2p/DM wake-up backfill) shipped.

This document is the destination. Tickets under `.scratch/backfill-self-echo/issues/` are disposable execution slices. Implementers claim tickets from the docs draft PR; they push product code only to a separate feat PR.

---

## Problem Statement

Owner intent: after `connect` / `reconnected` / keepalive `wake-up` backfill, the bot must **never** treat its own earlier replies as new user input. Today, in p2p chats, it does — and each wrong answer seeds the next one.

### Symptom (evidence)

Bridge logs: `~/.lark-channel/profiles/<profile>/logs/bridge-YYYYMMDD.jsonl` (times below are CST / Asia/Shanghai).

- **Profile `cursor` (agy bot).** Outbound reply `om_x100b649c3aefcca0b25d2de9ac62c80` sent 2026-09-28 23:26:58. Wake-up backfill at 2026-09-29 05:06:31 enqueued that same message id with intake `chatType=p2p sender=cli_aa2be781ee385cb1`; the bot re-replied to itself at 05:07:25.
- **Profile `grok`.** 2026-09-27 00:06:43 wake-up backfill enqueued **8** of the bot's own replies (sender `cli_aa05614529785be7`). 00:08:36 reconnected backfill enqueued another own reply.
- **Profile `cursor-claude`.** Not affected so far (same code path; exposure only).

### Mechanism (locked)

1. `filterHistoryItem` treats a history item as self only when `item.sender?.id === botOpenId` (`src/bot/backfill.ts:383`), where `botOpenId` is the bot's `ou_…` open id.
2. Feishu `im.v1.message.list` history returns **bot-sent** messages with `sender.id` = the **app_id** (`cli_…`) and `sender.sender_type = 'app'` — not the open id. The self check never matches the bot's own history items.
3. Groups were masked: the group/topic branch drops anything without `mentionedBot` (`src/bot/backfill.ts:403`), and the bot's own replies never @ the bot.
4. PR #34 made p2p backfill **not** require @ (`src/bot/backfill.ts:398-400`, `case 'p2p': break;`). Nothing else stops a bot-authored p2p item.
5. The ledger check (`src/bot/backfill.ts:410`, `deps.ledger.has`) only knows **accepted inbound** ids: `recordAccepted` (`src/bot/channel.ts:906-912`, called at `:898` / `:903`) records intake messages; outbound reply ids are never recorded. So own replies pass the ledger check and reach `intake` as new user messages.
6. **Echo chain.** The extra reply is itself a bot-authored p2p item inside the next backfill window, so the next backfill picks it up again (self-amplifying).

### Amplifier: persistent per-chat failure keeps the window open (ticket 02)

- Profile `grok`: every backfill run logs `mode-resolve-failed` for chat `oc_c7b54801575bc53ff5c7f41497b3c294` (HTTP 400). In `classifySessionP2pIds` (`src/bot/backfill.ts:517-541`, warn at `:533`) this increments `unresolved`, and `runBackfill` then calls `markScanIncomplete(lastLiveAt)` (`src/bot/backfill.ts:210-211`).
- `markScanIncomplete` keeps the **earliest** anchor (`src/bot/backfill-ledger.ts:124-130`), so `incompleteFrom` has been stuck at 2026-09-22 07:16 and `lastBackfillEnd` at 2026-09-21; `markScanComplete` (`src/bot/backfill-ledger.ts:132-140`) never runs.
- The short-gap skip only applies when `incompleteFrom === undefined` (`src/bot/backfill.ts:127`). With it stuck, even an 11 s reconnect triggers a full scan; `resolveBackfillWindow` (`src/bot/backfill.ts:49-66`) clamps to `now - lookbackMs` (default 6 h, `src/config/schema.ts:101`), so every reconnect rescans 6 h of history — maximising exposure to the self-echo above.

---

## Solution

1. Recognise the bot's own history items by **either** identity Feishu uses: open id (`ou_…`) **or** the bot's own app id (`cli_…`). Pass the app id into backfill from `channel.ts`, which already has it in config. Skip with the existing distinct `skip-self` reason.
2. In **p2p** chats, additionally skip any item with `sender_type === 'app'` (a p2p chat is only the user and this bot). Group/topic handling of **other** apps is unchanged.
3. Classify per-chat errors: a **non-retryable** per-chat error (HTTP 4xx, e.g. the 400 above) skips that chat for this window with a warn log and does **not** keep the window incomplete. Transient errors keep today's incomplete/retry behaviour.

No outbound-id ledger, no config flag, no disabling backfill.

---

## Seams

Prefer existing seams. Do not invent a parallel filter or a second ledger.

1. **Backfill filter seam (primary).** `filterHistoryItem` in `src/bot/backfill.ts:367-419` — widen the self check at `:383`; add the p2p `sender_type === 'app'` skip before normalize. Thread the app id through `RunBackfillDeps` (`src/bot/backfill.ts:35-47`) → `runBackfill` (`:97`) → `scanChat` (`:187-195`, `:284-293`) → `filterHistoryItem` (`:315`). `HistoryItem.sender.sender_type` is already parsed (`src/bot/backfill.ts:660`, `:665-670`).
2. **Wiring seam.** `launchBackfill` in `src/bot/channel.ts:398-417` (the `runScheduledBackfill({...})` call at `:400`). The app id is already in scope as `cfg.accounts.app.id` (used at `src/bot/channel.ts:238`, `:253`, `:546`, `:565`). Prefer reading it at launch time from the same live config object used for prefs (`controls.cfg`, `:404`) if it carries `accounts`, so a credential swap cannot leave a stale id; otherwise `cfg.accounts.app.id` is acceptable.
3. **Window-completion seam (ticket 02).** `classifySessionP2pIds` (`src/bot/backfill.ts:517-541`) and the per-chat `chat-fetch-failed` path in `scanChat` (`src/bot/backfill.ts:295-304`), feeding the incomplete decision at `src/bot/backfill.ts:210-211`. Classify the caught error (existing helper `errorCode`, `src/bot/backfill.ts:700-707`, is the natural neighbour; add an HTTP-status reader there).
4. **Out of scope seams.** Ledger schema / outbound recording (`src/bot/backfill-ledger.ts`, `recordAccepted`), bridge / supervise / keepalive, CLI config, `listChats` global failure path (`src/bot/backfill.ts:141-146`).

Ideal count: **one** load-bearing module (`src/bot/backfill.ts`) + a one-line wiring change in `src/bot/channel.ts`.

---

## User Stories

1. As a Feishu user in a DM, I want the bot to never answer its own earlier reply after it wakes up or reconnects, so I don't get phantom replies.
2. As a Feishu user in a DM, I want my own missed messages still caught up by backfill (PR #34 behaviour unchanged).
3. As a Feishu user in a group, I want @bot backfill to behave exactly as today, including messages from other bots that @ this bot.
4. As an operator, I want a distinct `skip-self` log line whenever backfill drops the bot's own message, so self-echo is visible in logs.
5. As an operator, I want one permanently broken chat (e.g. HTTP 400 on mode resolution) to not pin the backfill window open forever, so short reconnects stop triggering 6 h rescans.
6. As an operator, I want transient Feishu failures (5xx, network, timeout) to keep retrying the window as today, so real outages are still caught up.
7. As a dual-track implementer, I want a tracer ticket for self-echo and a follow-on ticket for failure isolation, claimed on the docs PR and pushed only to the feat PR.

---

## Implementation Decisions

Locked 2026-09-29. Do not Grill.

**D1 — Self identity = open id OR own app id.** A history item is the bot's own when `sender.id === botOpenId` **or** `sender.id === <this bot's app_id>`. Pass the app id into backfill from `channel.ts` (config app id; see Seams §2). Self items are skipped with the distinct reason `skip-self` (already emitted at `src/bot/backfill.ts:384`), logged with `msgId` and `chatId`. Applies to all chat types.

**D2 — p2p: skip any `sender_type === 'app'`.** In a p2p chat, any history item whose `sender.sender_type === 'app'` is skipped (a p2p chat contains only the user and this bot). Reuse the `skip-self` reason (or an equally distinct reason; must be logged). **Groups/topics:** other apps' messages keep existing behaviour — still governed only by the @ filter (an other-bot message that @ this bot is still enqueued; see existing test `drops deleted, self, and not-mentioned items; keeps other bots`). Do not broaden group filtering.

**D3 — Ledger stays inbound-only.** Do **not** add outbound message-id recording in this change. D1 + D2 are sufficient. No config flag; no disabling backfill.

**D4 — Echo-chain regression.** After one backfill pass, a second backfill over the same window must enqueue **nothing** that originated from the bot's own replies (neither the original replies nor replies produced in response to backfilled items).

**D5 — Groups unchanged.** Human messages that @ the bot are still backfilled; other-app messages without @ are still dropped; ledger skip (`skip-processed`), deleted skip (`skip-deleted`), slash-command skip (`skip-command`) unchanged in behaviour and log names.

**D6 — Persistent per-chat failure isolation (ticket 02).** A **non-retryable** per-chat error (HTTP 4xx, e.g. `mode-resolve-failed` with HTTP 400) must not keep the whole backfill window incomplete forever. That chat is skipped for that window with a `warn` log naming `chatId` and the HTTP `status`; the window advances (`markScanComplete` → `incompleteFrom` cleared, `lastBackfillEnd` moves) if all other chats succeed. **Transient** errors (HTTP 5xx, network, timeout) keep current incomplete/retry behaviour. Errors with **no** determinable HTTP status are treated as transient (preserves existing test `keeps the scan incomplete when session p2p mode lookup fails`, which throws a plain `Error`). No bounded-retry counters or new persisted state; classify the error.

**D7 — Out of scope.** Investigating why `oc_c7b54801575bc53ff5c7f41497b3c294` returns 400 (operator issue); first-contact DM discovery; outbound ledger; any bridge / supervise / keepalive changes; CLI config.

### Notes for implementers (not new decisions)

- **Status source (D6).** `getChatMode` in `@larksuite/channel` 0.7.1 calls `rawClient.im.v1.chat.get` and does not wrap errors, so the rejection is the node-sdk/axios error: HTTP status lives at `error.response.status`, Feishu business code at `error.response.data.code`. The existing `errorCode` helper returns `error.code` **first**, which on an axios error is a string like `'ERR_BAD_REQUEST'`, not the HTTP status. Read status explicitly; do not rely on `errorCode` for classification. `mode-resolve-failed` currently logs only `err` (`src/bot/backfill.ts:533-536`) — add `status`.
- **HTTP 429 (flagged).** 429 is a 4xx but is a rate limit, i.e. transient in nature. Recommended: treat 429 as transient (keep incomplete). This refines, not changes, D6; operator may override on the docs PR.
- **Which per-chat paths D6 covers.** Both per-chat failure sites that feed the incomplete decision: mode resolution in `classifySessionP2pIds` (the observed incident) and history fetch in `scanChat` (`chat-fetch-failed`). The global `listChats` failure (`chats-fetch-failed`) is not per-chat and stays as today.
- **Mode-resolve 400 chat is not scanned anyway.** An unresolved session chat that is not in `listChats` is never added to `sessionP2pIds`, so it is already skipped for scanning; D6 only stops it counting toward `unresolved` / incomplete.
- **Echo-chain test (D4).** The unit harness `intake` is a fake; in production the ledger records accepted inbound ids in `channel.ts` (`recordAccepted`), not in backfill. The D4 test must make the fake intake record accepted ids into the ledger (mirroring `recordAccepted`) so the second pass isolates the self-echo path.

---

## Testing Decisions

- Test **external behaviour** through the public backfill seam (`runBackfill` / `createBackfillRun` with fake channel, ledger, intake), not private helper names. Prior art: `tests/unit/bot/backfill.test.ts` (`harness`, `mentionItem`, `humanItem`, `chatModeErrors`), `tests/integration/bot/feishu-backfill-parity.test.ts` (config fixture already uses `accounts.app.id: 'cli_test'`).
- Required cases — ticket 01: p2p item from app-id sender skipped as `skip-self`; p2p item with `sender_type: 'app'` (non-own id) skipped; open-id self still skipped; echo chain (two passes, zero bot-reply enqueues); group human @bot still enqueued; group other-app without @ still dropped (other-app **with** @ still enqueued); ledger / deleted / slash skips unchanged.
- Required cases — ticket 02: mode resolution rejects with HTTP 400 on every run → run logs `done` (not `incomplete`), `incompleteFrom` cleared, `lastBackfillEnd` advanced, warn names `chatId` + `status`; next run with a sub-`minGapMs` gap logs `skip-short-gap`; 5xx / network / status-less error still `incomplete`; per-chat history fetch 4xx vs 5xx mirrors the same split.
- `/tdd` red then green inside `/implement`. `pnpm ci:local` green on the code PR head.

---

## Out of Scope

- Outbound message-id ledger / recording bot replies (D3).
- Config flag or disabling backfill (D3).
- Root-causing the HTTP 400 on `oc_c7b54801575bc53ff5c7f41497b3c294` (D7).
- First-contact DM discovery (still out of scope from p2p Spec D2).
- Bridge / supervise / keepalive changes; CLI config.
- Broadening group filtering of other apps (D2).
- Bounded-retry counters or new persisted ledger fields (D6).

---

## Acceptance Criteria (Spec-level)

- [ ] p2p history item with `sender.id === <own app_id>` is not enqueued; `skip-self` logged.
- [ ] p2p history item with `sender_type === 'app'` is not enqueued.
- [ ] open-id self still skipped in p2p and group.
- [ ] Two consecutive backfills over the same window enqueue no bot-authored item.
- [ ] Group: human @bot enqueued; other-app without @ dropped; other-app with @ still enqueued.
- [ ] `skip-processed` / `skip-deleted` / `skip-command` unchanged.
- [ ] A chat failing with HTTP 400 every run no longer keeps the window incomplete; short-gap skip works on the next run.
- [ ] 5xx / network / status-less failures still mark incomplete.
- [ ] Warn log includes `chatId` and `status`.
- [ ] No ledger schema change, no new config, no bridge/supervise/keepalive diff.
- [ ] Code PR red-then-green; `pnpm ci:local` green; no `.scratch/` or Spec on code PR.

---

## Tickets

| # | Title | Blocked by |
| --- | --- | --- |
| 01 | Self-echo tracer (app-id self + p2p app skip + echo-chain regression) | None |
| 02 | Persistent per-chat failure isolation (4xx does not pin window open) | 01 (same file) |

---

## Dual-track

- **Docs (this):** Spec + tickets + delivery-note placeholders only. Do not merge as product.
- **Code:** separate `feat/backfill-self-echo` — implementers claim 01 then 02 here and push only there.
