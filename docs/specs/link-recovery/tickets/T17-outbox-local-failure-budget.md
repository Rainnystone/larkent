# T17: Bounded outbox retries for failures with no HTTP status

**Status:** ready-for-agent · Source: 2026-10-17 loop audit of #47 @ `cc6d435`, finding **B2** (the remainder of the Codex "permanent reject resends forever" issue after `e6fce75` and `99480d2`; R3 in the PR #47 re-verification)

## Problem (current code, #47 @ `cc6d435`)

When a staged reply or notice fails with an error that `classify()` (`src/bot/feishu-error.ts`) sorts as `local`, the item stays `staged` forever:

- `turn-journal.ts` `redeliverOwned`: `case 'local'` only logs `resend-failed` / `notice-resend-failed`. Nothing on the item changes.
- `channel.ts` `runOutboxSweep`: if a pass makes no progress, it re-arms after `OUTBOX_IDLE_MS` (60 s). There is no per-item attempt count, no age limit and no terminal state.
- `channel.ts` `sendOrWait`: a `local` failure is retried once straight away, so each pass makes 2 `channel.send` calls. The SDK already retries `unknown` 3 times inside each call (see the facts below), so one pass can make up to 6 HTTP requests. Once an entry is older than 1 h, each pass also sleeps 2 s and reads back with `message.list` (`feishu-delivery.ts`).
- `TERMINAL_PRUNE` leaves out `completed-undelivered` and `notice-pending`, so neither the 7-day age prune nor the 200-entry cap removes the item. It survives restarts. In the audit mock it was still staged after 15 days and after a reload.

Result: one stuck item costs about 1 pass/min (2–6 requests) forever. It is invisible apart from one warn line per pass.

## Assumptions and how each was checked

Verified (source named):

| # | Assumption | Verdict | Source |
|---|---|---|---|
| V1 | For `im/v1/messages` create, reply and patch, every documented business error code is returned with **HTTP 400** and a body `code`. | Verified. create: 25 codes, reply: 26, patch: 12. All have `statusCode: 400`. That includes 230020 (frequency limit) and 230049 ("message is being sent, try later"). | Feishu open-platform docs: `reference/im-v1/message/{create,reply,patch}`, error-code tables (fetched 2026-10-17 through `document_portal/v1/document/get_detail`) |
| V2 | So "HTTP 200 with a non-zero body code" is **not** a documented failure shape for send, reply or patch. | Verified as far as the docs go. The docs only say `code` non-zero = failure, and list no 2xx error. | Same |
| V3 | `@larksuiteoapi/node-sdk` 1.73.3 returns `resp.data` for any 2xx and throws the axios error (with `response.status`) for non-2xx. | Verified | `node-sdk/lib/index.js` `defaultHttpInstance.interceptors.response` (~L196); the generated `im.v1.message.create` just `.catch(e => { log; throw e })` |
| V4 | `@larksuite/channel` 0.7.1 throws `LarkChannelError('unknown', 'message_id missing from … response')` **with no cause** when a 2xx body has no `data.message_id`. Any body `code` is lost, and the error has no HTTP status. | Verified | `channel/dist/index.mjs` `rawSend` ~L4498/4505 |
| V5 | `channel.updateCard` → `patchCard` **does not check the body `code`**. A 2xx patch with a non-zero code resolves as success. | Verified (source). Whether Feishu ever answers patch that way is **unverified**; see U1 | `dist/index.mjs` `patchCard` ~L4512 |
| V6 | The SDK's `retry()` retries `unknown` and `rate_limited` up to 3 attempts (backoff 500 ms, 1500 ms). `inferCode` maps a 5xx and a plain `Error` to `unknown`. Larkent does not override `outbound.retry`. | Verified | `dist/index.mjs` `retry` ~L3765, `inferCode` ~L3110; `src/bot/channel.ts` `createLarkChannel` options (only `streamThrottleMs`) |
| V7 | When the tenant-token request returns a 2xx body **without** `tenant_access_token`, node-sdk throws a **plain `Error`** (`failed to get tenant_access_token, code: …, msg: …`). It has no status and no cause, so larkent classifies it `local`. If the token endpoint answers non-2xx, the axios error (with status) propagates and is classified by status. | Verified (source) | `node-sdk/lib/index.js` `TokenManager.requestToken` / `buildTokenError` ~L100214–100264 |
| V8 | In 0.7.1, `LarkChannelError('not_connected')` is **not** thrown on the `send`/`updateCard` path. It comes only from `getBotIdentity()`, `connect()` and `joinMeeting()`. | Verified (grep of all `not_connected` throws) | `dist/index.mjs` L2008, L5487, L5512, L5553, L6112 |
| V9 | Feishu dedupes by `uuid`: requests carrying the same uuid send at most one message **within 1 hour**. Larkent sends every reply and notice with `uuid = deliveryId`, and per-chunk uuids are derived (`chunkDeliveryUuid`). | Verified | create doc, `uuid` parameter; spec §4a / T16; `dist/index.mjs` `chunkDeliveryUuid` |
| V10 | The outbox sweep never runs while the link is down (`runOutboxSweep` returns on `link.isDown()`, and `redeliverOwned` breaks on `isDown`). So `local` failures counted by the sweep happen while Feishu is otherwise reachable. | Verified | `channel.ts` `runOutboxSweep`; `turn-journal.ts` `redeliverOwned` |
| V11 | A `rejected` reply/notice already goes terminal and is prunable (`replyRejected` → `reply-delivered`, `noticeRejected` → `notice-delivered`; both in `TERMINAL_PRUNE`). | Verified | `turn-journal.ts` L282–359, L141 |

So the `local` sources that can actually occur on the resend path are:
1. The token request answered 2xx without a token (V7), which affects **every** call.
2. A 2xx with no `message_id` (V4), for example a proxy (`respectProxyEnv: true`) answering 200 with HTML, or an undocumented Feishu shape.
3. A larkent bug that throws a plain `Error`/`TypeError` while building or reading back, which is deterministic for that item.
4. Larkent's own `final journal-resend reply missing message receipt` (`feishu-delivery.ts`). This is practically unreachable, because the channel throws before returning an empty id (V4).
`not_connected` is not a real source on this path (V8).

Still unverified (the implementer must not rely on these without a live check):

| # | Assumption | Status |
|---|---|---|
| U1 | Feishu ever returns 2xx + non-zero `code` for create/reply/patch. | Unverified; not documented. If it happens on patch, V5 means a silent false "delivered" (a separate defect; see *Out of scope*). |
| U2 | What HTTP status the tenant-token endpoint uses when credentials are revoked, rotated or the app is disabled (2xx + code, or 4xx). | Unverified. The token doc defers to the generic error codes and lists no HTTP status. This decides whether a credential failure lands as `local` (V7) or `rejected`. |
| U3 | 230049 ("the message is being sent, try later") is really transient, and can be caused by retrying the same uuid while the first request is still in flight. | Unverified. Today it is HTTP 400 → `rejected` → terminal. Reported as a separate question; not changed here. |
| U4 | How often real deployments hit sources 1–2. | Unknown; no production evidence collected. |

## Design (from the facts above)

- A failure with no HTTP status says nothing reliable about whether a retry can succeed. Sources 1 and 3 are permanent until a human acts; source 2 is environmental. The bridge cannot tell them apart from the error object (V4, V7), so the policy must be **bounded by count and time, not by error type**.
- **Retries inside the uuid window cannot duplicate (V9).** A budget that ends within about 1 h of the first failure needs no read-back, so it adds no duplicate risk and no `message.list` cost.
- The budget must be **persisted on the item**, so restarts neither reset it nor extend it.

Concrete policy (numbers are a proposal; see *Needs user approval*):
- Per outbox item (reply and notice separately, I8), persist: `attempts`, `firstFailedAt`, `nextAttemptAt` and `lastFailure` (class plus Feishu code/HTTP status if present; no message text, no IDs beyond last 4 chars).
- A `local` failure increments `attempts` and sets `nextAttemptAt` by backoff: 1, 2, 4, 8, 16, 24 min. That makes 6 retries after the first failure, the last one at +55 min, so every retry falls inside the 1 h uuid window that starts with the first failed attempt. An entry already older than 1 h keeps today's read-back before each send.
- When the budget is exhausted, the item becomes terminal with a distinct reason (`undeliverable`, separate from `rejected`):
  - `log.fail('journal', …, { reason: 'local-budget-exhausted', attempts, lastFailure })` exactly once;
  - the entry becomes prunable.
- Drop the extra immediate `local` retry in `sendOrWait`: the SDK already retries `unknown` internally (V6). One sweep attempt is one `channel.send`/`updateCard` call per item.
- The sweep schedules itself by the earliest `nextAttemptAt` among staged items, not a fixed 60 s.
- `link`-class failures do not count toward this budget (they are T18's concern). `rejected` keeps today's terminal path.

## Acceptance (behaviour, failing first)

- [ ] A staged reply whose every resend throws `LarkChannelError('unknown', 'message_id missing …')` (no cause, no status) gets exactly 7 send attempts: the first, then retries at +1, +3, +7, +15, +31 and +55 min (fake clock). It then becomes terminal (`undeliverable`), produces exactly one `log.fail` with `reason: 'local-budget-exhausted'`, and gets **zero** further send calls over the next 24 h of fake time.
- [ ] Same for a staged **notice**. A reply and a notice on the same entry keep separate budgets (I8): exhausting one does not touch the other.
- [ ] Same for a plain `Error('failed to get tenant_access_token, code: …')` (V7 shape) and for a `TypeError` thrown inside delivery.
- [ ] After 3 failed attempts, restart the process (reload the journal from disk): the item resumes at attempt 4 at its persisted `nextAttemptAt`. It does not reset to attempt 1 and does not fire at once.
- [ ] An item that succeeds on attempt 3 is marked sent with its receipt, sends exactly one message (same uuid on every attempt), and logs no failure.
- [ ] One sweep attempt = exactly one `channel.send` (or `updateCard`) call for that item. The extra immediate `local` retry in `sendOrWait` is gone.
- [ ] While the link is down, no attempts are made and `attempts` does not grow.
- [ ] A `link`-class failure does not change `attempts`. A `rejected` failure still goes terminal on its first occurrence, as today.
- [ ] Terminal `undeliverable` entries are removed by the normal 7-day prune and count as droppable for the 200-entry cap.
- [ ] An old journal file without the new fields loads, and its staged items start with `attempts = 0`.
- [ ] No log line or journal field contains message text or a full Feishu ID.
- [ ] `pnpm ci:local` passes.

## Needs user approval (not adopted by this ticket)

1. **Giving up = a lost answer.** I1 says "no loss"; exceptions must be listed under *Known limitations* with sign-off. This ticket adds "reply/notice undeliverable after the no-status retry budget" as a Known limitation. The user must approve it, or choose to hold items indefinitely (today's behaviour, unbounded).
2. **Budget numbers** (6 retries over 55 min, sized to the 1 h uuid window). A longer budget would need read-back on every attempt after 1 h, which costs `message.list` calls.
3. **Surfacing beyond the log.** For example a one-time DM to the bot owner, or an entry in a status/doctor command. A DM is itself a send that may hit the same failure. Not built until the user picks one.
4. **Credential-wide failures** (source 1 affects every item at once). With this policy, every staged item goes terminal after about 55 min. The alternative is to detect "all calls fail `local`" and pause budgets until it clears; that keeps the low-rate retry going forever. The user needs to choose.

## Out of scope (separate follow-ups, reported here so they are not lost)

- V5: `patchCard` treats a 2xx with a non-zero body code as success. Only matters if U1 is real.
- `FEISHU_GONE_MESSAGE_CODES` comments do not match the Feishu docs (checked 2026-10-17): 230002 = "bot not in the group" (create/reply), 230025 = "message content too long". Recalled is 230011 and deleted (patch) is 230110. 230026 appears in none of the three tables. `isGoneMessage` therefore treats "too long" as "card gone". That does not cause a loop: the uuid fallback is also too long → 400 → terminal.
- U3: whether 230049 should be retried instead of terminal.

## Files likely touched

`src/bot/turn-journal.ts` (item fields, terminal reason, prune, load), `src/bot/channel.ts` (`runOutboxSweep` scheduling, `sendOrWait` local branch), journal/outbox tests, spec *Known limitations* (only after approval of item 1)

## Blocked by

None on the docs track; builds on T13/T16 as landed in #47 (`cc6d435`). Blocks T18.
