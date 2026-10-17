# A7: Bot removed / chat gone, DM, observability

Spec: [../../automations.md](../../automations.md) §8, §10, ADR-012

**What to build:** bot removed from the group or group disbanded → that group's tasks deleted, board no longer written, one log line; p2p `/auto` replies 仅支持群; structured events `auto.draft/confirmed/rejected/fire/missed/catch-up/wake.already-started/result/paused/deleted/expired/policy-guard/board.repin/removed-from-chat` without task text.

**Event path.** Add handlers for the Feishu events `im.chat.member.bot.deleted_v1` (bot removed) and `im.chat.disbanded_v1` (chat disbanded), and subscribe the Feishu app to both events in the developer console (operator docs). Today the bridge's `channel.on({...})` block (src/bot/channel.ts:739-856) handles `message`, `reject`, `cardAction`, `comment`, `reconnecting`, `reconnected` and `error`, with no chat-membership or disband handler. `@larksuite/channel@0.7.1` only dispatches `im.chat.member.bot.added_v1` itself (as `botAdded`). Subscribe the other two through its public `onRawEvent(eventType, handler)`, the same way src/meeting/manager.ts:119-136 does.

**Rejection path.** Add an explicit **not-in-chat** error class. Don't reuse `isGoneMessage`. Findings from the Feishu open docs (checked 2026-10-17, im/v1 message create, reply and card patch pages):
- `230002` = "The bot can not be outside the group" (send and reply): the bot isn't in the chat. src/bot/feishu-error.ts:8 labels it "invalid message id" and puts it in `FEISHU_GONE_MESSAGE_CODES`, so `isGoneMessage` (:134-142) returns true for it and stream recovery falls back to a uuid-keyed send (src/bot/feishu-delivery.ts:76). `@larksuite/channel@0.7.1` maps 230002 to `format_error`.
- `232009` = "chat which has already been dissolved" (send, reply, patch): treat it as not-in-chat too.
- Related, outside this feature (product code is not changed in this docs PR): the same docs give `230025` = message content too long (not "message not found", as feishu-error.ts:9 says), `230011` = message recalled, and `230110` = message deleted. `230026` isn't listed on those pages. Track a separate fix for `FEISHU_GONE_MESSAGE_CODES`.

**Blocked by:** A4

**Status:** ready-for-agent

- [ ] Bot-removed or chat-disbanded event deletes that group's tasks; no catch-up is attempted for them.
- [ ] A send rejected with 230002 or 232009 deletes that group's tasks; a gone-card code does not.
- [ ] Every lifecycle step emits exactly its event; no task body in logs.
