# 01: Backfill self-echo tracer

**What to build:** make backfill recognise the bot's own history items by open id **or** its own app id (`cli_…`), and in p2p chats skip any `sender_type === 'app'` item, so connect / reconnected / wake-up backfill never re-enqueues the bot's own replies (and the echo chain dies). Group behaviour unchanged. Prove with unit tests on the public backfill seam, red then green.

**Blocked by:** None

**Status:** ready-for-agent

## Parent

[docs/specs/backfill-self-echo.md](../../../docs/specs/backfill-self-echo.md) — D1, D2, D4, D5 (and D3, D7 as constraints); Problem Statement mechanism; Notes for implementers (echo-chain test).

## What to build

Today (`src/bot/backfill.ts` on master):

- `filterHistoryItem` (`:367-419`) skips self only when `item.sender?.id === botOpenId` (`:383`, logs `skip-self` at `:384`). Feishu history returns bot-sent messages with `sender.id = <app_id>` (`cli_…`), `sender_type = 'app'`, so the check never matches.
- p2p branch has no @ filter (`:398-400`); group/topic drops non-`mentionedBot` (`:403`); ledger check (`:410`) only knows accepted inbound ids.
- `RunBackfillDeps` (`:35-47`) has no app id; `scanChat` (`:284-293`) / `filterHistoryItem` receive only `botOpenId`.

Change:

- Add the bot's app id to the backfill inputs (e.g. `RunBackfillDeps.botAppId?: string`; name is implementer's choice) and thread it to `filterHistoryItem`.
- Wire it in `launchBackfill` (`src/bot/channel.ts:398-417`, call at `:400`) from the config app id already used in that file (`cfg.accounts.app.id`, `:238` / `:253` / `:546` / `:565`; prefer the live `controls.cfg` if it carries `accounts`).
- D1: self = `sender.id === botOpenId || sender.id === botAppId` (all chat types) → `skip-self` (`msgId`, `chatId`).
- D2: when `chatType === 'p2p'` and `sender.sender_type === 'app'` → skip (logged; `skip-self` or an equally distinct reason). Do **not** add any sender_type rule for group/topic.
- Keep the self/app checks before normalize (cheap, no merge-forward fetch for bot replies).

Tests (`tests/unit/bot/backfill.test.ts`), red first:

- p2p (session-known) history with a human message + bot reply whose `sender.id` is the app id → only the human message enqueued; `skip-self` for the reply.
- p2p item with `sender_type: 'app'` and an unrelated id → not enqueued.
- open-id self (`senderId: BOT`) still skipped (existing tests stay green).
- **Echo chain (D4):** fake intake records accepted ids into the ledger (mirroring `recordAccepted` in `channel.ts`); pass 1 over history [human, own reply A]; append own reply B (the "answer" to the backfilled item) to history; pass 2 over the same window → zero enqueues, no own-reply id ever handed to intake.
- Group human @bot still enqueued; group other-app without @ still dropped; group other-app **with** @ still enqueued (existing `keeps other bots` test unchanged).
- `skip-processed`, `skip-deleted`, `skip-command` unchanged.

Do **not**: record outbound ids, change the ledger schema, add a config flag, disable backfill, touch bridge/supervise/keepalive, broaden group filtering, or start ticket 02's error classification.

Delivery shape: prefer two commits on the code PR — (1) red tests (2) green change + `pnpm ci:local`.

## Acceptance criteria

- [ ] Red then green: new tests fail on master behaviour, pass after the change.
- [ ] p2p history item from the app-id sender is skipped as self (`skip-self` logged with `msgId`, `chatId`).
- [ ] p2p item with `sender_type: 'app'` is skipped.
- [ ] open-id self still skipped (p2p and group).
- [ ] Echo chain: two consecutive backfills over the same window do not enqueue any bot reply.
- [ ] Group human @bot message still backfilled.
- [ ] Group message from another app without @ still dropped as before (and with @ still enqueued).
- [ ] Ledger (`skip-processed`) / deleted (`skip-deleted`) / slash (`skip-command`) skips unchanged.
- [ ] `channel.ts` diff limited to passing the app id into backfill.
- [ ] `pnpm ci:local` green on the code PR; delivery note filled; no Spec/scratch on code PR.

## Out of scope

- Ticket 02 (per-chat 4xx isolation / window advance).
- Outbound ledger; config flag; disabling backfill (D3).
- Why `oc_c7b5…` returns 400; first-contact DM discovery; bridge/supervise/keepalive; CLI config (D7).
- Any change to group handling of other apps (D2).

## Blocked by

- None (can start immediately).
