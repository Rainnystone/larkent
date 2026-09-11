# Spike: Feishu history-API facts (V1–V3)

Dated 2026-09-11. Ticket 01. No `src/` change.

**Method.** No live Feishu tenant or profile credentials were available in this environment, and this spike does not start a bot or request account authorization. Answers are verified against:

1. Feishu OpenAPI *Get chat history* (`im.v1.message.list`) and *Topic overview* (retrieved 2026-09-11).
2. Channel SDK `@larksuite/channel@0.7.1` types (`ApiMessageItem`, `RawMessageEvent`).
3. Existing bot-identity usage in `src/bot/quote.ts` (`fetchTopicContext` → `channel.rawClient.im.v1.message.list`).

No human-user OAuth, no `--as user`, no secrets, tenant keys, or full open_ids.

---

## Decision for ticket 07

**Topic groups are top-level only in v1; log `backfill.topic-partial`.**

`container_id_type: 'chat'` does **not** return messages posted *inside* topics (threads). It returns top-level / topic-root messages only. Pulling every in-topic reply would need a second `container_id_type: 'thread'` list per active `thread_id`. That extra listing is out of v1 (spec §17 V1 fallback). Ticket 07 should page `chat` only, and when any listed item carries `thread_id` (or the chat is otherwise a topic group), emit `backfill.topic-partial` once for that chat.

---

## V1 — does chat listing include in-topic messages?

**Answer: no. Chat listing is top-level / topic-root only.**

Official `container_id_type` note (Feishu *Get chat history*):

> For thread messages in normal conversation groups, only the root message of the thread can be obtained through the `chat` container type. You can obtain all messages in the thread reply by specifying the container type as `thread`.

*Topic overview* “get all messages in a topic-mode group” is a two-step recipe:

1. `container_id_type: 'chat'` + group `chat_id` → page **root** messages (each root may carry `thread_id`).
2. For each root `thread_id`, `container_id_type: 'thread'` → page that topic.

Repo confirmation: `fetchTopicContext` already lists with `container_id_type: 'thread'` and documents that this is how you get every message in a topic, including a root that never @-mentioned the bot (`src/bot/quote.ts`).

`thread` listing does **not** accept `start_time` / `end_time` (same OpenAPI page). A v1 extra-per-thread scan could not reuse the backfill window filter.

### Redacted sample — top-level / topic-root (docs example, identifiers truncated)

Official response example fields, redacted. This is the shape `chat` listing returns (root-level item). The published example omits `thread_id` even though the schema defines it; a topic-group root is expected to add `thread_id`.

```json
{
  "message_id": "om_dc13…dcf",
  "root_id": "om_40eb…195",
  "parent_id": "om_d4be…a9f",
  "msg_type": "text",
  "create_time": "1615380573411",
  "update_time": "1615380573411",
  "deleted": false,
  "chat_id": "oc_5ad1…c20",
  "thread_id": "omt_d4be…16a",
  "sender": {
    "id": "ou_1551…4f2",
    "id_type": "open_id",
    "sender_type": "user"
  },
  "body": { "content": "{\"text\":\"@bot missed while offline\"}" },
  "mentions": [
    {
      "key": "@_user_1",
      "id": "ou_bot0…001",
      "id_type": "open_id",
      "name": "Bot"
    }
  ]
}
```

`thread_id` on this item is **schema-expected**, not live-observed. Marked residual below.

### Redacted sample — in-topic reply (schema-faithful, not returned by `chat` listing)

This item exists on a `thread` listing only. v1 backfill will **not** see it.

```json
{
  "message_id": "om_aa11…002",
  "root_id": "om_dc13…dcf",
  "parent_id": "om_dc13…dcf",
  "thread_id": "omt_d4be…16a",
  "msg_type": "text",
  "create_time": "1615380590000",
  "deleted": false,
  "chat_id": "oc_5ad1…c20",
  "sender": {
    "id": "ou_1551…4f2",
    "id_type": "open_id",
    "sender_type": "user"
  },
  "body": { "content": "{\"text\":\"@bot follow-up inside the topic\"}" }
}
```

---

## V2 — do list items expose `thread_id` / `root_id` / `parent_id` / `deleted` / `chat_id`?

**Answer: Feishu Message schema yes; SDK `ApiMessageItem` type no. Read them off the raw item.**

Exact field names on the OpenAPI *message* resource (list response `data.items[]`):

| Field | Type (docs) | Notes |
| --- | --- | --- |
| `message_id` | string | |
| `root_id` | string | reply tree / topic root |
| `parent_id` | string | parent in the reply tree |
| `thread_id` | string | omitted when the message is not a topic/thread message |
| `msg_type` | string | |
| `create_time` | string | **milliseconds** (example `1615380573411`) |
| `update_time` | string | milliseconds |
| `deleted` | boolean | recalled/deleted |
| `updated` | boolean | |
| `chat_id` | string | |
| `sender.id` | string | |
| `sender.id_type` | string | `open_id` / `app_id` |
| `sender.sender_type` | string | `user` / `app` / `anonymous` / `unknown` |
| `body.content` | string | JSON-serialized body |
| `mentions[]` | array | `key`, `id` (open_id **string**), `id_type`, `name` |

SDK `@larksuite/channel@0.7.1` `ApiMessageItem` only types:

`message_id`, `upper_message_id`, `msg_type`, `body.content`, `mentions`, `sender.{id,id_type,sender_type}`, `create_time`.

It **omits** `thread_id`, `root_id`, `parent_id`, `deleted`, `chat_id`. Repo already treats `deleted` as untyped: `fetchTopicContext` filters with `!(m as { deleted?: boolean }).deleted`.

Ticket 07 fetch should copy `thread_id` / `root_id` / `parent_id` / `chat_id` from the raw item onto the synthesized `RawMessageEvent` (those fields **are** on `RawMessageEvent.message`). If `thread_id` is absent on a topic-group item, `intakeMessage`'s `lookupMessageThreadId` fallback still covers it (one `message.get` per message).

**Mention shape mismatch (fetch detail):** OpenAPI `mentions[].id` is a string; SDK `RawMention.id` is `{ open_id?, user_id?, union_id? }`. `quote.ts` currently passes `parent.mentions` through unchanged. Ticket 07 should map string ids to `{ open_id }` so SDK `mentionedBot` (`mentions[].id.open_id === botIdentity.openId`) matches the live path.

---

## V3 — does bot-identity `message.list` work for a group the bot is in?

**Answer: expected yes when the app has the documented bot scopes; not live-confirmed here.**

Official prerequisites: bot capability enabled; robot must be in the queried group. Authorization may be `tenant_access_token` (bot / app identity) or `user_access_token`. This spike uses **bot identity only**.

Official **app-identity** scopes for `GET /open-apis/im/v1/messages` (need at least one from the first list; groups need the extra group scope):

- One of: `im:message`, `im:message:readonly`, `im:message.history:readonly`
- **Plus, for group chats as the app:** `im:message.group_msg`

Repo already uses bot-identity `message.list` in `fetchTopicContext` (`channel.rawClient`, tenant token). That is the same identity ticket 07 will use. No `--as user`.

This environment has no tenant, so the working scope set was **not** observed. Residual: a tenant that lacks `im:message.group_msg` (or any of the read scopes) fails the list call. Spec already routes that to per-chat `backfill.chat-fetch-failed`. Relevant documented codes:

| Code | Meaning |
| --- | --- |
| `230002` | bot is not in the group |
| `230027` | missing permission |
| `230073` | thread not visible to the operator |
| `231203` | chat type does not allow history (e.g. secret mode) |

`im:message.group_msg` in this repo (`src/bot/app-scope.ts`) is also the WS “receive undirected group events” scope. Official list-API docs independently require it for **reading** group history as the app. Spec V3 named only `im:message` / `im:message:readonly`; treat `im:message.group_msg` as the extra documented requirement, not a new product path.

---

## Time units and paging (confirmed from OpenAPI)

| Parameter | Unit / behaviour |
| --- | --- |
| `start_time` / `end_time` | **seconds** (examples `1608594809`, `1609296809`). Not supported on `container_id_type: thread`. |
| `create_time` on items | **milliseconds** |
| `sort_type` | `ByCreateTimeAsc` (default) or `ByCreateTimeDesc`. Must stay unchanged across `page_token` pages. |
| `page_size` | 1–50; OpenAPI default 20. Spec/ticket 07 use 50 (max). |
| paging | `has_more` + `page_token`; omit `page_token` on the first page. |

Ticket 07 should send `start_time: floor(windowStart/1000)` and `end_time: ceil(windowEnd/1000)` as already written in the spec.

`fetchTopicContext` already pages `page_size: 50` + `ByCreateTimeAsc` + `page_token` on the `thread` container (no time range, matching the docs restriction).

---

## Residual risks (no live tenant)

1. **Topic-root `thread_id` presence** is schema-documented and described in *Topic overview*, but the published list-API example omits the field. If a tenant’s `chat` listing drops `thread_id` on topic roots, ticket 07 still logs `backfill.topic-partial` when `chatModeCache` / `getChatMode` says `topic`, and `lookupMessageThreadId` covers intake.
2. **`im:message.group_msg`** may be required for group `chat` listing even when `im:message` is granted. Failures stay on the existing per-chat path; operators who already use `/config` “reply without @” have likely granted it.
3. **Mention `id` string vs object** is inferred from OpenAPI vs SDK types, not a captured payload. Wrong mapping would under-detect `@self` (R3) rather than double-run.
4. **Secret-mode / invisible-thread groups** (`231203`, `230073`) look like ordinary per-chat fetch failures.
5. A later live check (bot-identity `message.list` on one topic group + one ordinary group) should confirm V1 samples and the granted scope set; it should not change anything except the fetch step.

---

## What ticket 07 should do at the fetch seam

- `im.v1.message.list` with `container_id_type: 'chat'`, bot identity (`channel.rawClient`), second-resolution window, `ByCreateTimeAsc`, `page_size: 50`.
- Read `thread_id` / `root_id` / `parent_id` / `deleted` / `chat_id` off the raw item, not `ApiMessageItem`.
- Map `mentions[].id` strings to `{ open_id }` before `normalize`.
- Do **not** fan out a `thread` list per topic in v1. Log `backfill.topic-partial` for topic groups / items that carry `thread_id`.
- Treat scope / membership errors as `backfill.chat-fetch-failed` and continue other chats.
