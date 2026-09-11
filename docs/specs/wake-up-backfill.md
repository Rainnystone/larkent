# Spec: Wake-up @mention backfill (in-bridge self-heal)

Status: design approved through grill rounds (round 1 of 3 used; frontier empty), ready for implementation planning.
Written 2026-09-11. No implementation in this document's PR.

Vocabulary introduced here is defined in [CONTEXT.md](../../CONTEXT.md) (section "Self-heal and backfill"). Code, tests and PR bodies use those words.

---

## 0. Principles and end-state

The current architecture — Channel SDK 0.7.x, per-profile runtime under a supervisor, peer agent adapters, keepalive, `intakeMessage` → `PendingQueue` → `runAgentBatch` — is intentional. This spec designs *with* those seams and adds no parallel delivery path, no side process and no host-specific workaround.

Principles, in priority order:

1. **Single writer of truth for outbound.** One user turn has exactly one authoritative final delivery to the triggering chat, and the bridge owns it. Agents may send *elsewhere*; they do not post the final answer to the current chat. (Problem A enforces this; Problem B relies on it.)
2. **At-least-once intake, idempotent processing.** WS delivery is lossy across disconnects, so intake is completed by history catch-up; a durable `message_id` ledger makes processing exactly-once regardless of how many times or by which path a message arrives.
3. **Self-heal inside the bridge.** Recovery needs no external watcher, patrol, poller, scheduler or host routine. It works on any host: laptop sleep, process crash, service restart, WS blip, hypervisor freeze.
4. **Runtime equality.** Agents are peers (`AGENT_KINDS` in `src/agent/registry.ts`). The capability lives once in the shared bot layer (`src/bot/`) and is identical for every profile and agent kind. No agent kind, profile name or bot name appears in product code or defaults.
5. **Smallest reversible change.** One new store, one new runner, one hook in keepalive, one claim in intake, one config block, one kill switch — all shaped like the stores, timers and gates that already exist.

Also binding: **bot identity only** for reads and writes (`channel.rawClient`, tenant token). No human user's OAuth is used or assumed to exist.

Today → end-state:

| | Today (`origin/master`) | End-state after this spec (+ Problem A's own PR) |
|---|---|---|
| WS dead for 10 min–2 h, user @'s the bot | Silence; user resends; sometimes late event + resend → two answers | Bridge catches up on reconnect, answers each missed @ once, with a lateness hint |
| Same `message_id` arrives twice (late WS + backfill, or WS + WS across restart) | Two runs possible (no bridge-level ledger; SDK cache is per instance) | Exactly one run; the loser logs `intake.skip-duplicate` |
| Agent IM-sends to the current chat mid-turn | Two near-identical posts | One post; bridge skips its final when the agent already delivered (Problem A) |
| Process restart / host reboot | Debounced messages lost silently; nothing recovered | Ledger + watermark survive; missed @ inside the window are recovered |
| Where recovery logic lives | Nowhere; operators bolt on external patrols | Inside every bridge, identically for every profile |

---

## 1. Problem statement

Two failure modes have been observed on real deployments. Only B is in scope; A is documented because operators see both as "the bot posted twice / the bot went silent" and they interact at the dedupe boundary.

### Problem A — double outbound in one turn (related, **out of scope**)

Symptom: two near-identical bot replies to one user turn in a group.

Cause: the agent, mid-run, sends to the **current** chat itself (`lark-cli im +messages-send` / `+messages-reply`), and afterwards the bridge's `sendFinalReply` (`src/bot/channel.ts`) posts the run's final text as well.

Status on `origin/master` at time of writing: **not fixed**. There is no `directImSentChatIds` on `RunState`, no `skip-cli-already-sent` branch in `sendFinalReply`, and `src/agent/bridge-system-prompt.ts` only instructs the agent to *send as bot*, not to *leave the final outbound to the bridge*. A fix exists in at least one operator's local tree. It is a separate, small change and must land as its own PR:

1. `RunState` tracks chat ids the agent successfully IM-sent to during the run.
2. `sendFinalReply` skips when `terminal === 'done'` and the target chat is in that set; logs `outbound.skip-cli-already-sent`.
3. Bridge agent instructions state: do not IM-send to the current chat; the bridge owns the final outbound.

Desired end-state (principle 1): the agent never IM-sends to the triggering chat; if it nevertheless did and succeeded, the bridge does not post a second final; instructions and docs say so explicitly.

This spec does not re-implement A. Backfill must not make A worse: a backfilled run is an ordinary run and gets A's fix for free once A lands.

### Problem B — missed @mentions while the WebSocket is dead (**this spec**)

Symptom: a user @-mentions the bot while the bridge's WS is not receiving (host or VM frozen/suspended, laptop lid closed, process restarted, network blip, Feishu-side disconnect). After recovery the bot stays silent. Later the user resends, and sometimes a late-delivered original event *also* arrives, so the bot answers twice.

Facts (verified in repo and SDK, see section 3):

- Feishu does **not** replay WS events missed while disconnected. History is only available by API pull.
- The SDK drops any WS message whose `createTime` is older than 30 minutes (`staleMessageWindowMs`). So a late WS event can still reach the bridge for outages **shorter** than 30 min, and never for longer ones.
- The bridge keeps no persistent record of which message ids it has processed. Every restart (`controls.restart()`) rebuilds the whole bridge and drops in-memory state, including messages still sitting in the 600 ms debounce queue.

Required capability: after any recovery, the bridge **catches up by itself** — pulls recent group history with bot identity, finds messages that @-mention this bot and were never processed, and runs them through the normal intake path exactly once.

---

## 2. Goals and non-goals

### Goals

G1. After wake-up, reconnect or process (re)start, missed @mentions in watched group chats are processed without human action.
G2. A `message_id` is never processed twice, whether it arrives live, late, via backfill, or via two overlapping triggers.
G3. Backfilled messages take the **same** path as live ones (access gate, mention gate, command handling, per-scope debounce, `runAgentBatch`, reply-to-original), so behavior parity holds for every agent kind.
G4. Bounded cost: fixed caps on lookback time, chats scanned, raw messages paged, and mentions replayed.
G5. Fully observable in the profile log; no user-visible chatter beyond the replies themselves.
G6. Small, reversible change: one new store, one new runner module, a heartbeat hook in keepalive, a claim in intake, one config block. Kill switch.

### Non-goals (explicit)

- **No external poller** (no cron, no 1–5 min routine, no second process). Same-machine pollers freeze with the machine; off-machine ones violate standalone.
- **No user-identity scan.** Never read groups with a human's OAuth token or `--as user`.
- **No host dependency.** No Grok Bot / any host routines, message buses, box-specific paths, or tools. No hard-coded profile or bot names.
- **No preferential agent or runtime.** Nothing in this feature branches on `agentKind`.
- **No P2P/DM backfill in v1.** Group and topic-group chats only. (DM is a follow-on; see section 19.)
- **No content/intent near-duplicate dedupe in v1** (user resends the same question after silence). `message_id` dedupe only; follow-on in section 19.
- **No chat notice** ("I was offline for N minutes"). The prompt tells the agent the message is late; the agent may say so itself.
- **Not a fix for Problem A.**

---

## 3. Facts the design rests on

Repo, `origin/master` at `101079b`, SDK `@larksuite/channel@0.7.1`.

| # | Fact | Where |
|---|------|-------|
| F1 | Keepalive ticks every 15 s; a gap > 30 s between ticks logs `keepalive.wake-up`. `forceReconnect` is `controls.restart()`. | `src/bot/keepalive.ts` |
| F2 | `controls.restart()` → supervisor `reconnect()` → **new** bridge via `startChannel` (new `LarkChannel`, `PendingQueue`, `ChatModeCache`, `ActiveRuns`), connect-before-disconnect, then old `disconnect()` which calls `pending.cancelAll()`. Debounced-but-unflushed messages are lost. | `src/runtime/supervisor.ts`, `src/bot/channel.ts` |
| F3 | `sessions`, `sessionCatalog`, `workspaces` are profile-level stores injected into every `startChannel`; they survive restarts. | `StartChannelDeps` |
| F4 | The SDK's own `reconnected` event fires on SDK-internal WS reconnects (no bridge rebuild). | `channel.on({ reconnected })` |
| F5 | SDK pipeline order for a WS event: stale filter (30 min) → in-memory seen cache (12 h TTL, 5000 ids, per `LarkChannel` instance) → policy → handler. Neither applies to messages the bridge synthesizes itself. | SDK `safety` pipeline |
| F6 | `channel.rawClient.im.v1.message.list` works with `container_id_type: 'chat'`, `start_time`/`end_time` (seconds), `sort_type`, `page_size`, `page_token`. Items carry `message_id`, `msg_type`, `body.content`, `mentions`, `sender.{id,sender_type}`, `create_time`, and (per Feishu API) `chat_id`, `thread_id`, `root_id`, `parent_id`, `deleted`. The bridge already uses this endpoint with `'thread'` in `fetchTopicContext`. | `src/bot/quote.ts` |
| F7 | SDK `normalize(rawEvent, { botIdentity })` computes `mentionedBot` from `mentions[].id.open_id === botIdentity.openId`. The bridge already synthesizes `RawMessageEvent` from API items and normalizes them. | `src/bot/quote.ts`, SDK `fetchMessage` |
| F8 | Live intake: `channel.on({message})` → `intakeMessage` → `canUseGroup`/`canUseDm` → `requireMentionForChat` → `tryHandleCommand` → `pending.push(scope)` → 600 ms debounce → `runAgentBatch`; reply uses `replyTo: lastMsg.messageId`, `replyInThread` for topics. `intakeMessage` awaits (`chatModeCache.resolve`, `lookupMessageThreadId`, `tryHandleCommand`) **before** `pending.push`. | `src/bot/channel.ts` |
| F9 | `controls.knownChats` is `channel.listChats` (groups the bot is in, ≤ 500), refreshed every 30 min. Access is `profile.access.allowedChats` in `personal` mode; `team` mode (this fork's default) allows any group, so `allowedChats` is commonly empty. | `src/bot/lark-info.ts`, `src/policy/access.ts` |
| F10 | Persistence template: `CallbackNonceStore` — JSON map in `profileDir`, `writeFileAtomic` mode 0o600, serial persist queue, `load()` at start, `flush()` at disconnect. | `src/card/callback-store.ts`, `src/platform/atomic-write.ts` |
| F11 | Multi-sender debounce batches are rendered with `[name (type)]:` sender annotations; `extraInstructions` already exist on the prompt for one-off notes (model switch). | `buildPrompt`, `runAgentBatch` |

---

## 4. Design overview

```
                 ┌────────────────────────────────────────────────────────┐
 keepalive tick  │  Live watermark: lastLiveAt written when WS==connected  │
 (every 15 s)  ─►│  (throttled to ≥30 s between writes)                    │
                 └───────────────┬────────────────────────────────────────┘
                                 │ profileDir/backfill-state.json
                                 ▼
 trigger ──► BackfillRunner ──► window = [min(lastLiveAt, lastBackfillEnd) − 2 min, now]
  (any of:                       │ skip if gap < minGapMs (60 s) or disabled
   connect OK in startChannel,   │
   SDK `reconnected`)            ▼
                       fresh listChats ──► filter chats (access gate, override list, cap 50)
                                 │
                                 ▼ per chat, sequential
                       message.list(chat, window, asc) ──► normalize(item, botIdentity)
                                 │
                                 ▼ keep: mentionedBot && !command && !own && !deleted && !ledger.has(id)
                       newest N (20) ──► mark backfill ──► intakeMessage(msg)   (same path as WS)
                                                           │ sync claim(id) at entry
                                                           │ persist processed(id) at acceptance
                                                           ▼
                                                   PendingQueue → runAgentBatch (prompt gets lateness hint)
```

New code, all in the shared bot layer:

| Unit | Responsibility |
|------|----------------|
| `src/bot/backfill-ledger.ts` — `BackfillLedger` | Profile-level store: `lastLiveAt`, `lastBackfillEnd`, processed `message_id` map. Load/claim/record/prune/flush. |
| `src/bot/backfill.ts` — `runBackfill(deps)` | Trigger-agnostic catch-up routine: window, chat discovery, fetch, normalize, filter, cap, hand to intake. Per-profile mutex. |
| `src/bot/keepalive.ts` | New optional dep `onConnectedTick(now)`; called on each tick that observes `state === 'connected'`. |
| `src/bot/channel.ts` | Wire ledger into `intakeMessage` (claim + record), fire backfill after `channel.connect()` and on `reconnected`, add lateness hint in `runAgentBatch`. |
| `src/config/schema.ts` / `profile-schema.ts` | `preferences.backfill` block with defaults. |
| `src/runtime/supervisor.ts` | Own one `BackfillLedger` per managed profile and pass it via `StartChannelDeps` (like `sessions`). |

---

## 5. Triggers (decision Q1: option c + gap threshold)

The routine is **idempotent** (ledger + watermark), so it is safe to run on every recovery signal:

| Trigger | Where | Covers |
|---------|-------|--------|
| T1 `startChannel` completes `channel.connect()` and `ownerRefresh.start()` | `src/bot/channel.ts`, right after the `ws.connected` log | keepalive wake-up → `controls.restart()`; `/reconnect`; `/account` swap; **process start** after crash, OOM, host reboot, service restart |
| T2 SDK `reconnected` event | `channel.on({ reconnected })` | short WS blips the SDK repaired itself (no bridge rebuild) |

Gap threshold: the runner computes `gap = now − lastLiveAt` (section 6). If `gap < backfill.minGapMs` (default 60 000) it logs `backfill.skip-short-gap` and returns. This stops N API calls per chat on a flapping network.

Not a trigger: the keepalive `wake-up` log line itself. Wake-up on the local tree already leads to `controls.restart()` → T1. If a future keepalive keeps the socket instead of restarting, it fires T2-equivalent by calling `runBackfill` directly; the routine does not care which trigger invoked it.

Ordering on T1: backfill runs **after** `ownerRefresh.start()` (so `canUseGroup`'s owner check has data) and after `agent.setBotIdentity`, and is `void`-launched (never blocks `startChannel` from returning). Its promise is tracked like run consumers so `disconnect()` waits for it.

---

## 6. Window (decision Q2: live watermark, option a)

`lastLiveAt` = the most recent keepalive tick that observed `channel.getConnectionStatus().state === 'connected'`, persisted with writes throttled to ≥ 30 s apart. Why "observed connected", not "tick fired": during a WS blip the process is alive and ticks keep firing; anchoring on *connected* makes the watermark stop advancing exactly when messages start being missed. During a freeze no tick fires at all, so both signals agree.

```
windowStart = max(now − lookbackMs,  min(lastLiveAt, lastBackfillEnd) − watermarkMarginMs)
windowEnd   = now
```

- `watermarkMarginMs` = 120 000 (constant; covers heartbeat throttle + clock skew + the SDK's own ping cadence).
- `lastBackfillEnd` is included so an interrupted backfill (crash mid-scan) resumes from where the last complete one ended, not from a watermark that kept advancing after it.
- First run ever (no file): `lastLiveAt` is absent → `windowStart = now − lookbackMs`? **No.** A missing watermark means the bridge has never run with this feature; replaying six hours of history on first deploy would surprise users. Rule: absent watermark → write `lastLiveAt = now`, log `backfill.watermark-initialized`, do not scan.
- Clock went backwards (`lastLiveAt > now`): treat gap as 0, log `backfill.clock-skew`, rewrite watermark.
- After a scan completes (all chats attempted, success or per-chat failure), `lastBackfillEnd = windowEnd` and `lastLiveAt = now`.

---

## 7. Chats in scope (decision Q4: option b + optional c)

1. Call `channel.listChats({ pageSize: 100, maxPages: 5 })` fresh (do not trust the 30-min `knownChats` cache; also refresh `controls.knownChats` from the result as a side benefit).
2. If `backfill.chats` (override list of `oc_…` ids) is non-empty, intersect with it.
3. Pre-filter by access mode: in `team` mode every listed chat is in scope; in `personal` mode only chats in `access.allowedChats` are scanned. This is an optimization to avoid paging chats that no ordinary sender can pass — the sender-specific `canUseGroup` decision is still applied per message inside `intakeMessage`. Documented consequence: in `personal` mode an owner/admin @-mention in a non-allowlisted group is not backfilled (it would have been answered live).
4. Cap at `backfill.maxChats` (default 50), most recently listed first (API order). Log `backfill.chats-truncated` with the dropped count if the cap hits.

P2P chats are not returned by `listChats` and are excluded by design in v1.

Per-chat mention policy (`requireMentionForChat`) is **not** used to widen scope: even in a chat configured to answer everything, backfill replays only messages with `mentionedBot === true`. Rationale: an explicit @ is the unambiguous "the user wanted the bot" signal; replaying undirected chatter hours late is noise.

---

## 8. Fetch, normalize, detect @self

Per chat, sequentially (concurrency 1 across chats; simple, rate-limit friendly):

```
im.v1.message.list({
  container_id_type: 'chat', container_id: chatId,
  start_time: floor(windowStart/1000), end_time: ceil(windowEnd/1000),
  sort_type: 'ByCreateTimeAsc', page_size: 50, page_token
})
```

Page until `has_more` is false or `backfill.maxRawPerChat` (default 200) items were collected — keeping the **newest** 200 when the window holds more (log `backfill.raw-truncated`).

Each item is converted to a `RawMessageEvent` with **real** `chat_id`, `chat_type: 'group'`, `thread_id`/`root_id`/`parent_id` when present, `create_time`, `mentions`, `sender.sender_id.open_id`, `sender.sender_type`, and normalized with SDK `normalize(raw, { botIdentity: channel.botIdentity, stripBotMentions: true, fetchSubMessages })` — the same options the live path uses, so `content`, `mentionedBot`, `mentions`, `resources`, `threadId`, `replyToMessageId` come out identical to a WS delivery. `@self` detection is therefore the SDK's, not a hand-rolled compare.

`fetchSubMessages` reuses `fetchSubTreeItems` from `quote.ts` so merge-forwards expand (or produce the `fetch_failed` sentinel) exactly as live.

---

## 9. Filter rules

Applied in order; each drop is logged once per message at `info` with the reason.

| # | Drop when | Log event |
|---|-----------|-----------|
| R1 | item `deleted === true` or no `message_id` | `backfill.skip-deleted` |
| R2 | `sender.id === botIdentity.openId` (our own message) | `backfill.skip-self` |
| R3 | `mentionedBot !== true` (includes `@所有人`-only, matching SDK `respondToMentionAll: false`) | *(not logged individually; counted)* |
| R4 | `ledger.has(message_id)` | `backfill.skip-processed` |
| R5 | content is a slash command (`tryHandleCommand`'s recognizer, e.g. starts with `/` and matches a registered command) | `backfill.skip-command` |
| R6 | beyond `backfill.maxMentionsPerChat` (default 20), keeping the **newest** | `backfill.mentions-truncated` (one line per chat, with count) |

Messages from other bots (`sender_type: 'app'`) are **not** filtered here — the live path does not filter them either, and the SDK loop guard is opt-in. Caps bound the blast radius.

R6-truncated ids **are recorded in the ledger** as processed (see section 10) so a later trigger with an overlapping window does not resurrect them.

Survivors are handed to intake oldest-first (section 11).

---

## 10. Processed ledger (decisions Q6, Q7)

### File

`<profileDir>/backfill-state.json` — sibling of `sessions.json`, `workspaces.json`, `callback-nonces.json`. `writeFileAtomic`, mode 0o600, serialized through the same serial-persist pattern as `CallbackNonceStore`.

```json
{
  "schemaVersion": 1,
  "lastLiveAt": 1757600000000,
  "lastBackfillEnd": 1757599000000,
  "processed": {
    "om_xxx": 1757598000000
  }
}
```

`processed[id]` = the message's `createTime` in ms (used for pruning; independent of wall-clock at record time).

### Ownership across restarts

The ledger is a **profile-level** store, created once per managed profile in the supervisor and passed through `StartChannelDeps` exactly like `sessions`. It is **not** created inside `startChannel`. Reason: `controls.restart()` runs connect-before-disconnect (F2), so for a moment two bridges exist for one profile; two independent in-memory ledgers writing one file would clobber each other.

### When a message becomes "processed" (option b)

| Moment | Action |
|--------|--------|
| `intakeMessage` entry (both live and backfill) | **Synchronous** `ledger.claim(messageId)`: returns `false` if the id is already processed or currently claimed. On `false`, log `intake.skip-duplicate` `{ source: 'ws' \| 'backfill' }` and return before any `await`. This closes the race in F8 (awaits before `pending.push`). |
| gated out (not allowed, no mention, forward-fetch-failed) | `ledger.release(messageId)` — not persisted. Gates are deterministic; if the same id appears again via another path it is re-evaluated to the same result. |
| accepted: `pending.push(...)` or `tryHandleCommand` returned `handled` | `ledger.record(messageId, createTime)` — persisted (throttled). |
| R6 truncation in backfill | `ledger.record(...)` for each truncated id. |

Accepted residual (operator-approved): a message accepted into the 600 ms debounce at the exact instant the bridge is torn down is recorded but never runs. Choosing "record at run start" instead would need cross-bridge in-flight tracking for a sub-second window; not worth it.

### Pruning and bounds

- On `load()` and after every scan: drop entries whose `createTime < now − 2 × lookbackMs` (12 h by default) — nothing older can fall inside a future window.
- Hard cap 5000 ids; when exceeded, evict oldest by `createTime`.
- Loader rules follow CONTEXT.md persistence rules: validate `schemaVersion`, reject unknown future versions without overwriting, ENOENT → empty ledger.

### Not done in v1

The SDK's `LarkChannelOptions.cache` (backing store for its seen cache) is **not** wired to this ledger. The SDK stale filter makes its cache irrelevant past 30 min, and the bridge-level ledger already covers both paths.

---

## 11. Interaction with live intake (decision Q8: option b)

- **No global block.** `PendingQueue` is never blocked for backfill. If the API hangs, live traffic must keep flowing.
- **Per-profile backfill mutex.** `runBackfill` holds a single in-flight promise; a second trigger while one runs *coalesces* (returns the same promise) and logs `backfill.coalesced`. A trigger arriving after completion starts a new scan with the updated watermark.
- **Ordering within a scope.** Backfill hands survivors to `intakeMessage` oldest-first, per chat. They join the scope's normal debounce; multiple missed @ in one scope merge into **one** run with sender annotations (F11). A live message arriving mid-backfill for the same scope joins the same batch (it is, by construction, newer). If a run is already active on the scope, `pending.block` holds the batch for the next run — unchanged behavior.
- **Late WS event vs backfill for the same id** (possible only for outages < 30 min, F5): whichever reaches `intakeMessage` first wins the claim; the other logs `intake.skip-duplicate`. The SDK's own seen cache additionally drops WS re-deliveries within the same `LarkChannel` instance.
- **Two bridges during `restart()`** (F2): the ledger is shared (section 10), so a live message accepted by the old bridge in the overlap window is already recorded when the new bridge's backfill scans. Messages the old bridge accepted but lost in `pending.cancelAll()` are the accepted residual.
- **`/reconnect --wait` pause.** `handleReconnect` pauses new runs on the **old** bridge's `ActiveRuns`; the new bridge has a fresh one, so backfilled runs are not rejected as `reconnect-in-progress`.

### Backfill marker and lateness hint (decision Q5, Q9c)

`runBackfill` records `backfillMarks: Map<messageId, { detectedAt: number }>` on the bridge (in-memory, per bridge instance) before calling `intakeMessage`. `runAgentBatch` consults it for the batch; when any message is marked, it appends one `extraInstructions` line, e.g.

> 以下用户消息是在 bot 离线期间发出的（约 N 分钟前，HH:MM），bridge 重连后才补处理。如需，可先简短说明延迟原因再回答。

and deletes the marks. `NormalizedMessage` is not extended; nothing is stuffed into `raw`.

---

## 12. Failure modes

| Failure | Behavior | Log |
|---------|----------|-----|
| `listChats` fails | Abort scan for this trigger; watermark **not** advanced; next trigger retries | `backfill.chats-fetch-failed` (warn) |
| `message.list` fails for one chat (after SDK retry) | Skip that chat, continue others; watermark advances (bounded loss, logged) | `backfill.chat-fetch-failed` (warn, chatId, err) |
| Rate limited (`99991400`/429) | Treat as chat-fetch-failed; do not retry inside the scan | same + `code` |
| `normalize` throws for an item | Skip item | `backfill.normalize-failed` (warn) |
| `intakeMessage` throws for a backfilled item | Same as live (`log.fail('intake', …)`); claim released; continue | existing |
| Ledger file corrupt / unknown schema | Start with empty in-memory ledger; **do not overwrite** the file; disable persistence for this run and warn once | `backfill.ledger-load-failed` (warn) |
| Ledger persist fails | Same semantics as `CallbackNonceStore`: `log.fail`, keep running in-memory; `flush()` on disconnect surfaces the failure | `backfill.ledger-persist-failed` |
| Backfill still running at `disconnect()` | `disconnect` awaits it (tracked consumer); `closing` flag makes remaining hand-offs no-ops | `backfill.aborted` |
| Bot identity missing (`channel.botIdentity` undefined) | Skip scan (cannot detect @self) | `backfill.skip-no-identity` (warn) |
| Watermark absent (first run) | Initialize, no scan | `backfill.watermark-initialized` |
| Clock skew | Gap treated as 0, no scan | `backfill.clock-skew` (warn) |
| Bridge frozen again mid-scan | Nothing special: on next thaw T1/T2 fires; window uses `lastBackfillEnd` from the last **complete** scan | — |

---

## 13. Observability

All lines use the existing `log.<level>('backfill', event, fields)` shape. Required events (add to a `REQUIRED_BACKFILL_EVENTS` list in `src/observability/events.ts` for a static test, mirroring `REQUIRED_OBSERVABILITY_EVENTS`):

| Event | Level | Fields |
|-------|-------|--------|
| `backfill.trigger` | info | `trigger: 'connect' \| 'reconnected'`, `gapMs`, `windowStart`, `windowEnd` |
| `backfill.skip-short-gap` | info | `gapMs` |
| `backfill.skip-disabled` | info | `gapMs` |
| `backfill.skip-no-identity` | info | `gapMs` |
| `backfill.watermark-initialized` | info | — |
| `backfill.chats` | info | `listed`, `inScope`, `truncated` |
| `backfill.chats-truncated` | info | `dropped` |
| `backfill.chat-scanned` | info | `chatId`, `raw`, `mentions`, `enqueued`, `skippedProcessed`, `skippedCommand`, `truncated` |
| `backfill.enqueued` | info | `chatId`, `msgId`, `ageMs`, `scope` |
| `backfill.would-enqueue` | info | same fields; emitted instead of `enqueued` when `dryRun` is on |
| `backfill.done` | info | `chats`, `enqueuedTotal`, `durationMs`, `lastBackfillEnd` |
| `backfill.coalesced` | info | — |
| `backfill.aborted` | info | — |
| `backfill.chats-fetch-failed` | warn | `err` |
| `backfill.chat-fetch-failed` | warn | `err`, `code`, `chatId` |
| `backfill.normalize-failed` | warn | `err`, `chatId`, `msgId` |
| `backfill.clock-skew` | warn | `lastLiveAt`, `now` |
| `backfill.skip-deleted` | info | `msgId`, `chatId` |
| `backfill.skip-self` | info | `msgId`, `chatId` |
| `backfill.skip-processed` | info | `msgId`, `chatId` |
| `backfill.skip-command` | info | `msgId`, `chatId` |
| `backfill.raw-truncated` | info | `chatId`, `seen`, `kept`, `dropped` |
| `backfill.mentions-truncated` | info | `chatId`, `count` |
| `backfill.topic-partial` | info | `chatId` |
| `intake.skip-duplicate` | info | `msgId`, `source`, `scope` |

`outbound` lines for backfilled runs are unchanged; the `prompt.built` line gains `backfilled: <count>`.

Metrics via `reportMetric`: `backfill_enqueued` (count), `backfill_duration_ms`, `backfill_chat_fetch_failed` (count), `intake_duplicate_dropped` (count, tag `source`).

`/doctor` (`handleDoctor`) gains one line: ledger path, `lastLiveAt` age, `processed` size, last `backfill.done` summary. `/status` unchanged.

---

## 14. Configuration (decision Q10, portable defaults)

Profile `preferences.backfill` (shared `AppPreferences` in `src/config/schema.ts`; the same block for every profile and agent kind):

```jsonc
{
  "preferences": {
    "backfill": {
      "enabled": true,            // kill switch
      "dryRun": false,            // true: full scan, log `backfill.would-enqueue` per survivor, hand nothing to intake, advance watermark
      "lookbackMs": 21600000,     // 6 h hard cap on window
      "minGapMs": 60000,          // skip scans for gaps shorter than this
      "maxChats": 50,
      "maxRawPerChat": 200,
      "maxMentionsPerChat": 20,
      "chats": []                 // optional oc_… allowlist; empty = all groups the bot is in
    }
  }
}
```

Defaults are applied by the profile normalizer (`normalizeProfile`) so an absent block behaves as above. Getters follow the `getRunIdleTimeoutMs`-style pattern in `schema.ts`. `/config` UI exposure is optional and not required for v1; `/doctor` shows the effective values.

No default, path or constant in code refers to a profile name, bot name or agent kind.

---

## 15. Rollout and risk

### Risk register

| Risk | Mitigation |
|------|------------|
| Replaying stale @ hours later annoys users | 6 h cap, newest-20 cap, lateness hint in prompt, kill switch |
| API cost on restart storms | `minGapMs`, `maxChats`, sequential paging, coalescing mutex |
| Double-run via late WS | synchronous claim + shared profile-level ledger + SDK seen cache |
| Ledger growth | 12 h prune, 5000 cap |
| First deploy floods | watermark-initialized rule: no scan without a prior watermark |
| Regression in live intake | claim/record are two synchronous calls; contracts B1–B3 in section 16 pin parity |

### Operator guidance (optional, generic)

Any staged rollout is an operations choice, not product behavior:

1. Deploy with `backfill.enabled: true` on one profile; leave others `false` if you prefer a canary. `dryRun: true` gives a zero-risk first look: the scan runs and logs what it *would* replay without posting.
2. Wait for at least one real recovery cycle (`keepalive.wake-up` or `ws.reconnected` followed by `backfill.trigger` … `backfill.done` in that profile's log) and confirm no `intake.skip-duplicate` storms and no unwanted late replies.
3. Enable on the remaining profiles. All profiles run identical code; there is no per-agent tuning.

### Reversibility

Set `backfill.enabled: false` (no scans, heartbeat still written so re-enabling has a fresh watermark), or revert the PR; the ledger file is inert and can be deleted.

---

## 16. Behavior contracts / test plan (for the implementation PR)

Tests are shape requirements; the implementation PR writes them first and they must fail before the change.

- **B1 Idempotent replay.** Given a fake `message.list` returning 3 @mentions in one chat and an empty ledger, one trigger enqueues 3; a second trigger with the same data enqueues 0 and logs `skip-processed` ×3.
- **B2 Late WS vs backfill.** Backfill hands id X to intake; a live event for X arrives before `pending.push` resolves → exactly one `queued`, one `intake.skip-duplicate`. And the mirror order.
- **B3 Same path parity.** For a parameterized set over all `AGENT_KINDS`, a backfilled mention produces the same channel call sequence as the identical live message plus exactly one extra `extraInstructions` line (extend `tests/integration/bot/feishu-parity.test.ts`).
- **B4 Caps.** 250 raw items / 30 mentions → 200 paged, newest 20 enqueued, 10 truncated ids recorded in ledger.
- **B5 Watermark math.** Absent → initialize/no scan; blip < 60 s → skip; 3 h freeze → window ≈ 3 h + 2 min; 9 h → 6 h cap; skew → no scan.
- **B6 Ledger survives restart.** `controls.restart()` with a shared ledger: ids recorded by the old bridge are `skip-processed` for the new one; file has one writer.
- **B7 Command skip.** `/stop` found in history is not replayed; `backfill.skip-command` logged.
- **B8 Failure isolation.** Chat 2 of 3 throws on `message.list` → chats 1 and 3 processed, `chat-fetch-failed` once, `backfill.done` still logged.
- **B9 No identifiers.** Static test: `src/` contains no profile or bot names in backfill code paths; `preferences.backfill` defaults are agent-kind independent.
- **B10 Observability.** `REQUIRED_BACKFILL_EVENTS` all emitted across B1–B8.

---

## 17. Verification items for the implementation PR

Facts to confirm against the live API before coding the fetch layer (they change the fetch step only, nothing else in this spec):

- V1 `im.v1.message.list` with `container_id_type: 'chat'` includes messages posted inside topics (threads) of a topic group. If not, topic groups need one extra listing per active thread; v1 then limits topic-group backfill to top-level messages and logs `backfill.topic-partial`.
- V2 List items expose `thread_id` (Feishu Message schema says yes; the SDK `ApiMessageItem` type omits it). If absent, `intakeMessage`'s existing `lookupMessageThreadId` fallback covers it at one `message.get` per message.
- V3 Bot-identity permission for `im:message:readonly` / `im:message` on a group where the bot is a member suffices for `message.list` (expected yes, as `fetchTopicContext` already relies on it). If a tenant denies it, the per-chat failure path applies.

---

## 18. ADRs

### ADR-1 Catch up inside the bridge, on recovery signals, not from an external poller
Context: history must be pulled; a poller on the same machine freezes with it, an off-machine one breaks standalone, and a "go look" DM is ambiguous and races late WS.
Decision: run an idempotent catch-up routine inside the bridge on every recovery signal (connect in `startChannel`, SDK `reconnected`).
Consequences: zero new processes or credentials; cost bounded by caps and a gap threshold.

### ADR-2 Bot identity for reads
Context: user OAuth would widen the permission surface and tie the feature to a human account.
Decision: read history through `channel.rawClient` (tenant token). Never `--as user`.
Consequences: works on any install with only the app's own scopes; tenants that deny bot reads degrade to per-chat failure logs.

### ADR-3 Same intake path with a marker, not a summary prompt
Context: parity across agent kinds and reuse of gates, debounce, reply threading.
Decision: normalize API items into `NormalizedMessage` and call `intakeMessage`; carry lateness via a bridge-side mark → one `extraInstructions` line.
Consequences: one delivery path; multiple missed @ per scope merge into one run automatically.

### ADR-4 Persistent, profile-level `message_id` ledger with synchronous claim
Context: restarts rebuild the bridge (F2); SDK dedupe is per-instance and WS-only; intake has awaits before enqueue.
Decision: ledger owned by the supervisor per profile, injected like `sessions`; claim at intake entry, record at acceptance, prune at 2× lookback / 5000 ids.
Consequences: dedupe holds across restarts and across live/backfill; accepted residual is the debounce-drop at teardown.

### ADR-5 Live watermark = last tick that observed a connected WS
Context: `sleptMs` is unavailable after a process restart and blind to WS blips while the process lives.
Decision: keepalive writes `lastLiveAt` only when the WS is `connected`; window = watermark − 2 min, capped at 6 h; missing watermark initializes without scanning.
Consequences: freeze, blip and restart share one window definition; first deploy never floods.

### ADR-6 Only explicit @mentions are replayed, only in group chats, caps newest-first
Context: chats configured to answer everything would replay hours of chatter; oldest questions are least useful late.
Decision: `mentionedBot === true` only; skip commands; newest 20 per chat; 50 chats; 200 raw.
Consequences: predictable, small replays; DM and content-dedupe deferred.

### ADR-7 No named profiles, no agent branching, no staged default
Context: product law (standalone, equality).
Decision: one config block with the same defaults for all profiles; rollout ordering is operator documentation only.
Consequences: any install gets the full capability on upgrade.

---

## 19. Follow-ons (not in v1)

- P2P/DM backfill (needs a DM chat discovery source; `listChats` returns groups only).
- Content/intent near-duplicate suppression when a user resends after silence (needs a policy for "same question twice" that does not eat legitimate repeats).
- Wiring the SDK `cache` option to the ledger so SDK-level dedupe also persists.
- `/config` card toggle for `backfill.enabled`.
- Problem A upstreaming (separate PR, see section 1).
