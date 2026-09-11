# 01: Spike — verify Feishu history-API facts (V1–V3)

**What to build:** Nothing in `src/`. A short, dated notes file at `.scratch/wake-up-backfill/notes/api-verification.md` that answers the three open facts in spec §17 against a real Feishu tenant, using **bot identity only** (the profile's own app credentials via `channel.rawClient` or a bot-identity `lark-cli` call). The answers decide the exact shape of the fetch step in ticket 07; nothing else in the spec depends on them.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] V1 answered: does `im.v1.message.list` with `container_id_type: 'chat'` on a **topic group** return messages posted inside topics (threads), or only top-level messages? Include a redacted sample item from each case.
- [x] V2 answered: do list items expose `thread_id` (and `root_id` / `parent_id`, `deleted`, `chat_id`)? Record the exact field names observed; note that the SDK `ApiMessageItem` type omits them so the fetch step will read them off the raw item.
- [x] V3 answered: with the bot's current scopes, does `message.list` succeed for a group the bot is a member of? Record the scope set that worked and the error code seen if any scope was missing.
- [x] Confirmed `start_time` / `end_time` units (seconds) and behaviour of `sort_type: 'ByCreateTimeAsc'` with `page_size: 50` paging.
- [x] Notes file states the resulting decision for ticket 07: "chat listing covers topics" **or** "topic groups are top-level only in v1; log `backfill.topic-partial`".
- [x] No human user's OAuth was used; no secrets, tenant keys or full open_ids appear in the notes.
