# Spec: Unified Feishu link recovery (disconnect → recover)

Status: ready-for-agent · Docs track: this PR · Code track: separate draft PR (one ticket per session)
Tickets: [`link-recovery/tickets/`](link-recovery/tickets/README.md)

## Problem Statement

From the operator's and the chat user's point of view: when the machine running the bridge sleeps, the
box is frozen or snapshot-rolled-back, DNS stops resolving, outbound traffic to Feishu is blackholed, or the
network is merely slow, the bridge sometimes:

- never answers a message that was @-mentioned during the outage, or answers it twice;
- leaves a streamed reply half-finished and marks it delivered, so no reply or notice ever arrives (E2E A2);
- lets a hung run block every later message in the chat indefinitely (E2E A3);
- after an interruption, answers an ordinary follow-up by continuing the *previous* half-finished turn, and the
  "continue" card is never updated (E2E A1);
- restarts the whole bridge on a WebSocket hiccup, killing healthy CLI runs and posting a "保活重启" notice.

All of these share one root cause: **the bridge has no single "Feishu was unreachable, now it's back"
transition.** Backfill, journal resend, notice resend and stall handling each hang off a different trigger
(connect, SDK `reconnected`, keepalive wake-up, supervisor swap, every connected tick) or off matching an error
message. Sleep, freeze, DNS failure, blackhole and slow network are **one case** — the link was down for an
interval — and recovery must key on that interval, not on the error type or the trigger that noticed it.

## Solution

One module owns reachability of Feishu (**FeishuLink**). It decides up/down structurally from evidence and
emits `recovered({since, until})` exactly once per outage. One function (**Recovery**) is the only thing that
runs on that transition: redeliver staged replies and notices, backfill the outage window, review active runs.
Every terminal reply is staged in an **Outbox** before its first attempt, in every reply mode, so a failed final
patch is redelivered after recovery. One per-scope state machine (**Continuations**) decides whether the next
batch resumes or abandons an interrupted turn. Runs are bounded by default. The six "match master" reliability
flags and the three in-process dedupe guards are deleted: no legacy branch remains.

User-visible contract after an outage of any cause:

- every inbound message gets **exactly one** complete answer (or, if the run was interrupted, exactly one notice): no duplicate and no loss (invariant I1, user decision 2026-10-17). The only exceptions are the residuals under *Known limitations* that are marked as needing sign-off;
- the queue drains; no chat stays blocked behind a dead run longer than the idle bound;
- an ordinary message after an interruption **abandons** the previous turn (card → 已放弃) and only the new
  message is answered; only the button or typed 继续 resumes (card → 已继续);
- WebSocket blips never restart the bridge or kill runs.

## User Stories

1. As a chat user, I want a message I @-mentioned while the bot host was asleep to be answered once after it wakes, so that I don't have to resend it.
2. As a chat user, I want the same when the host was frozen or snapshot-rolled-back, so that freezes look like sleep to me.
3. As a chat user, I want the same when DNS failed, so that resolver outages are not special.
4. As a chat user, I want the same when Feishu was blackholed while the WebSocket still looked connected, so that half-open sockets don't swallow my message.
5. As a chat user, I want slow networks to delay replies rather than lose or duplicate them.
6. As a chat user, I want a streamed reply whose final update failed to be delivered again after recovery, so that I always see the answer or a notice.
7. As a chat user, I want at most one redelivered reply per turn, so that recovery does not spam the chat.
8. As a chat user, I want a run that went silent to end within the idle bound with a notice, so that my queued messages run next.
9. As a chat user, I want a long tool call to be allowed to run, but not forever (at most 60 minutes), so that real work isn't killed while hangs are bounded.
10. As an operator, I want `runIdleTimeoutMinutes` to default to 15 and `0` to disable it, so that the safe behaviour is the default.
11. As a chat user, I want an ordinary message after an interruption to be treated as a new request and the old turn shown as 已放弃, so that the bot doesn't continue something I moved on from.
12. As a chat user, I want the 继续 button or typing 继续 to resume the interrupted turn exactly once, so that resuming is explicit.
13. As a chat user, I want a stale 继续 button to say 此继续已失效, so that I understand why nothing happened.
14. As a chat user, I want the abandon/continue decision to survive a bridge restart, so that kill -9 doesn't change the semantics.
15. As a chat user, I want an unknown failure that overlapped an outage to offer 继续 with network wording, so that I can recover from transient errors.
16. As a chat user, I want auth and quota failures to keep asking for human action, so that retries don't hide real problems.
17. As an operator, I want WebSocket reconnects handled by the SDK transport only, so that a hiccup never restarts the bridge or kills runs.
18. As an operator, I want no "保活重启" notices, so that the chat only hears about real interruptions.
19. As an operator, I want process start and supervisor swap to be "just another recovery", so that there is one code path to trust.
20. As an operator, I want the reachability probe to use the same proxy and timeout as replies, so that proxied deployments are judged correctly.
21. As an operator, I want the live watermark to advance only on evidence, so that a half-open socket can't erase an outage.
22. As a maintainer, I want the legacy reliability flags gone, so that the test matrix and code paths halve.
23. As a maintainer, I want the dedupe guards gone, so that delivery correctness doesn't depend on in-process races.
24. As a maintainer, I want recovery tests to assert on what the user receives, not log events, so that refactors don't break them.
25. As a maintainer, I want `CONTEXT.md` to define link, outage, outbox and continuation, so that vocabulary matches code.
26. As an operator, I want old profiles containing removed keys to load and save cleanly, so that upgrades are silent.

## Implementation Decisions

### 1. Glossary

- **Link** — the bridge's belief about whether Feishu is reachable, both WebSocket and REST.
- **Outage** — an interval `{since, until}`; `since` is the last positive evidence of reachability, `until` the first fresh evidence after it.
- **Outbox** — durable staging of terminal replies and notices until Feishu confirms delivery (the turn journal with a narrow interface).
- **Continuation** — the per-scope offer to resume an interrupted turn, and its resolution (continued / abandoned / voided).

### 2. FeishuLink (replaces the bridge keepalive)

Interface (type shape from the architecture review):

```ts
interface Outage { since: number; until: number; hostSuspended: boolean } // true only with real OS sleep evidence inside the outage (§5)
interface FeishuLink {
  isDown(): boolean;
  outageEpoch(): number;                       // +1 on every up→down
  onRecovered(fn: (o: Outage) => void): () => void;
  noteInbound(at?: number): void;              // inbound WS event = evidence
  stop(): void;
}
startFeishuLink(deps: {
  channel: LarkChannel;                        // reads connection status; wraps outbound calls
  probe: () => Promise<boolean>;               // authenticated REST GET, same proxy agent + HTTP timeout as replies
  watermark: { get(): number | undefined; set(at: number): void }; // written ONLY by the link
  now?: () => number;
}): FeishuLink & { tick(): Promise<void> };
```

- Starts **down** with `since` = persisted watermark; start and swap therefore recover.
- **Down** on: WebSocket not `connected` at a tick; two ticks > 30 s apart (`since` = last tick; this alone does **not** mark `hostSuspended`, see §5); outbound timeout, no HTTP response, or 5xx; probe failure. Structural, never stderr/message text. Business 4xx keeps the link up.
- **Up** when WebSocket connected **and** fresh evidence (probe ok, outbound ok, inbound event). Emits `recovered` exactly once.
- Watermark advances only on evidence while up.
- Probe: every tick while down; while up only after 60 s without evidence (catches REST blackhole behind a "connected" socket).
- **No reconnect authority.** SDK keepalive owns WebSocket reconnect; unrecoverable only logs. Sleep detection and the heartbeat file move here.

### 3. Recovery

```ts
createRecovery(deps: {
  journal: { reapOrphans(): Promise<void>; redeliver(): Promise<void> };
  backfill: { scan(fromMs: number): Promise<void> };
  runs: { review(o: Outage): void };
}): { run(o: Outage): Promise<void> }   // coalesced: one in flight + one queued
```

Order: (1) reap orphans and redeliver staged replies/notices; (2) backfill
`[max(now − lookback, min(since, incompleteFrom) − margin), now]` — no `minGapMs`, no `lastBackfillEnd`;
(3) review active runs. The bridge's `recoverMissed` becomes `recover()` calling the same `run`; the supervisor
swap is a second caller of one implementation. Nothing else triggers backfill or resend — in particular, no
resend on connected ticks.

### 4. Outbox

- `stageReply(turnId, {markdown, replyTo, replyInThread?})` before the first attempt in **every** reply mode (text, markdown stream, card, CoT), including streamed; `replyDelivered(turnId, messageId)`; `stageNotice`; `noticeDelivered`; `redeliver()`; `reapOrphans()`.
- The free-form `update(Partial)` is removed; transitions live in the module.
- The streaming pipeline's final render reports success/failure instead of swallowing it. A failed final patch leaves the turn staged; recovery finishes the **same** message, never a new one (see *Exactly-once delivery* below).

### 4a. Exactly-once delivery (no duplicate, no loss)

Checked against master `426f670`, the `@larksuite/channel` 0.7.1 source, and a live Feishu proof run on 2026-10-17 (facts marked *verified*).

1. **Feishu request idempotency.**
   - Every final reply and notice is sent with `uuid = deliveryId`. The `deliveryId` is the stable per-turn key `replyDeliveryKey(turnId)`, already persisted in the turn journal. It is kept, no longer stripped by `stripOutboundUuid`, and must be at most 50 characters.
   - The uuid is set inside the SDK's `rawSend` through a `pnpm patch` of `@larksuite/channel`, on `im.v1.message.create` / `reply`, so the SDK's own internal retries (`rawSendWithRetry` on `unknown` errors) carry it too.
   - Feishu sends at most one message per uuid within 1 hour ([message create docs](https://open.feishu.cn/document/server-docs/im-v1/message/create)).
   - *Verified:* a repeated uuid on `create` or `reply` returns code 0 and the **original** `message_id`, never an error. A send that landed but whose response was lost, resent with the same uuid, returns the original id, and the chat holds one message.
   - *Verified:* a repeat with different content gets a response body that echoes the new text, while the stored message keeps the original content. **On any send, trust only the returned `message_id`, never the response body.**
2. **Streamed and card replies: patch the same interactive card.**
   - The stream message id is recorded as the receipt when the stream message is created. *Verified:* `stream()` in card mode exposes its message id at creation, and it equals the id `stream()` returns.
   - If the final write is uncertain, recovery does a replace-all patch of that same interactive card (`updateCard` / `im.v1.message.patch`) with the full answer. It never sends a new message. *Verified:* patching twice leaves the final content and creates no new message; a post-stream `updateCard` to the final card works.
   - If the stream message was never created, recovery falls back to the uuid-protected send from (1).
   - **CardKit (`updateCardById`) is unverified.** The update call succeeds, but `im.v1.message.get` returns only an "upgrade client" placeholder, so its content cannot be confirmed by read-back. Interactive-card patch is the recovery path. Markdown streams need a patch of the SDK or a bridge-owned interactive card (not CardKit, unless that is verified later) so that a failed final write is reported.
3. **Read-back beyond the 1-hour uuid window.** Before a redelivery send outside the window, the bridge lists the chat with `rawClient.im.v1.message.list`.
   - *Verified:* the list does **not** expose uuid; the bot sender appears as its app id, not an open_id; a new message is visible after about 1.6 s.
   - Match the bot's answer by: `parent_id` equal to the triggering inbound message id (bot answers always reply to the trigger), sender equal to the bot's app id, and `create_time` after the turn started (or simply the recorded receipt id).
   - Page through with a hard cap.
   - **Never embed visible markers in reply content** for matching.
   - If a match is found, the item is marked sent (or its card is patched). Otherwise, exactly one send.

### 5. Liveness

- `runIdleTimeoutMinutes` defaults to **15**; **0** disables.
- An open tool call pauses the watchdog for **at most 60 minutes**.
- Run handles expose `lastEventAt`. `runs.review(outage)` gives any run silent since before `since` a 2-minute stall deadline, then requests stop with the bridge idle-watchdog reason; it ends through the normal outcome + notice path.
- **Run review and host suspend** (user decision 2026-10-17): the review may give a deadline to, or stop, a silent run with an **open tool call** only if the host actually suspended or slept during the outage (`outage.hostSuspended`). A pure network/link outage with no host suspend never deadlines or stops such a run; the 60-minute tool-call cap still applies. Silent runs with no open tool call are reviewed as before.
- **What counts as host suspend** (user decision 2026-10-17): only real OS sleep evidence inside the gap counts.
  - Linux: `/proc/uptime` (boottime) minus the monotonic clock grows across the gap.
  - macOS: `kern.waketime` / `kern.sleeptime` shows a wake inside the gap.
  - Windows: the System event log has a power transition (sleep/wake) inside the gap.
  - Each check has its own timeout. If it fails, times out, or finds no evidence, the host was **not** suspended, and review never stops or deadlines runs with an open tool call.
  - A frozen process (SIGSTOP), an event-loop stall, CPU starvation, a debugger pause or a wall-clock jump is **not** sleep. A tick gap alone proves nothing.
  - Optional manual check (not a merge gate): a Mac lid-close test. The guard is a precaution; the likely deployment is an always-on Mac mini.

### 6. Outcome / retriability

- Outcome input gains `outageOverlapped` (outage epoch changed during the run).
- `unclassified` becomes retriable; if it overlapped an outage its cause becomes `transient-upstream`.
- CLI signatures only choose card wording and set `needsHuman` (auth, quota).
- The `keepalive-restart` stop reason is removed.

### 7. Continuations

```ts
type Taken =
  | { kind: 'none' }
  | { kind: 'continue'; turnId: string; resumeHandle?: string; userInput?: string; instruction: string }
  | { kind: 'abandoned'; turnId: string; instruction: string };
interface Continuations {
  offer(turnId: string, outcome: RunOutcome): void;
  click(turnId: string): boolean;                                   // false if stale
  take(scope: string, batch: NormalizedMessage[]): Promise<Taken>;  // updates card 已继续 / 已放弃
  voidScope(scope: string): void;                                   // /new, /cd, /ws, /resume
}
```

- `take` runs once per batch. **Ordinary message → `abandoned`**: instruction says the interrupted turn was given up and must not be continued or redone; only the new message is handled; card → **已放弃**. This instruction is needed because the resumed CLI session still contains the half-finished turn.
- **Button or typed 继续 → `continue`**: resume handle + continue hint; card → **已继续**; resumes exactly once.
- Later click on an abandoned/voided offer → 此继续已失效. State is persisted and survives restart. The streak counter lives inside this module.

### 8. No tech debt

Removed outright (current defaults kept as the only behaviour): the six reliability flags
`lostMessage`, `shortGapScan`, `runOutcome`, `cliSignatures`, `journal`, `journalRecover`; and the three dedupe
guards (outbound UUID in-flight map, journal delivery lock, live-notice send set). Profiles containing the old
keys load and are saved without them.

### 9. Deletion table

| Area | What goes |
|---|---|
| Bridge keepalive module | Whole module; sleep detection + heartbeat file move into FeishuLink |
| Bridge channel | Backfill `trigger` parameter and its four call sites (connect, SDK reconnected, wake-up, swap) |
| Bridge channel | Connected-tick hook and resend-on-every-tick; keepalive wiring and escalation to `controls.restart` |
| Bridge channel | `alreadyStreamed` staging skip; flag bits in stream reliability options |
| Bridge channel | `pendingHintByScope`, `continueByScope`, `consecutiveByScope`, `takeContinueRequest`, `rebuildPendingHints`, `rebuildConsecutive`, hint-setting in turn notice |
| Backfill | `BackfillTrigger`; skip-short-gap / forced branches |
| Backfill ledger | Scan completion writing `lastLiveAt`; `touchLive` policy |
| Self-message / outbound | `inflightByUuid`, `outboundInFlight`, `attachOutboundUuid`, `stripOutboundUuid`; outbound wrapping moves into the link |
| Turn journal | `deliveries`, `withDelivery`, `isDelivering`, `noteDelivery`, public `update` |
| Interruption notice | `liveNoticeSends`, in-flight checks, `stageOnly` |
| Run outcome | `keepalive-restart` stop reason |
| Config | `BackfillPreferences.minGapMs`; the six reliability flags |

### 10. Same PR vs deferred

**Same PR (the code track):** retriability from shape; transport-only reconnect; flag removal; removal of the
three dedupe guards; `CONTEXT.md` updates (recovery signal, live watermark, `recover()`, backfill window) and the
log-flow line in operations docs; rewriting log-asserting recovery tests to assert on user-visible output.

**Deferred:** full turn-delivery extraction from the channel (four mode branches); doc-comment runs via the
common run flow and outbox; runs surviving `/reconnect` and `/account` swaps; exiting when the WebSocket can't
connect at startup; SDK upstream asks (proxy-aware keepalive probe, public `reconnect()`); the runner `timeouts`
seam; command splitting / single preferences parser; e2e proxy cleanup (D1).

## Delivery invariants

Every delivery change must keep these true. They come from the 2026-10-16 failure-mode audit of the code branch (T11–T16).

- **I1 Exactly one complete answer per inbound message.** Every inbound message ends with exactly one complete answer the user can see, or exactly one notice if its run was interrupted. No duplicate, no loss. A duplicate is a bug, not an acceptable trade-off. *(User decision, 2026-10-17. It replaces the audit's "duplicate OK, loss not OK" wording, which was never approved.)*
- **I2a Retries are idempotent.** Every send of a final reply or notice, including the SDK's internal retries and redelivery after recovery, carries the same `deliveryId` as its Feishu `uuid`. A streamed answer is completed by patching its own card. Past the uuid window, a read-back by `parent_id` runs before any send (§4a). Only the returned `message_id` is trusted, never the echoed body.
- **I2 Only the bridge's own awaited calls confirm delivery.** A delivery counts only when a call the bridge awaited returned a receipt (message id). The SDK's internal throttled stream writes never count, because they always resolve.
- **I3 Everything terminal goes through the outbox.** Replies, notices and notice-card resolutions are staged before their first attempt. They leave the outbox only on a receipt, on a terminal "rejected" after their fallback, or when the user explicitly voids them.
- **I4 One error classifier.** A single function sorts every Feishu error into exactly one of `link`, `rejected` or `local`. It looks through wrapper errors (`.cause`), is used by both FeishuLink and delivery, and never matches message text.
- **I5 Only link errors take the link down.** A success or a rejection (4xx) is evidence that Feishu is reachable; a local error is evidence of nothing.
- **I6 No attempts while down.** While the link is down, delivery stages and returns. Recovery delivers, and stops at the first link error.
- **I7 Timeouts are per request.** Each REST call has its own timeout. No timeout spans a long-lived operation such as a whole stream.
- **I8 Reply and notice are separate items.** Each has its own state and receipt; settling one never re-sends the other.
- **I9 Recovery steps are independent and idempotent.** One step failing does not skip the others, and running a step twice is harmless.
- **I10 Test doubles behave like the real SDK.** Fake stream `update`/`setContent` never reject, and fake errors are `LarkChannelError` with the HTTP error as `cause`.

## Testing Decisions

- Good tests assert on what reaches the chat (replies, notices, card states, queue drained) through the recording Lark channel and fake clock/probe — never on log event names.
- Every ticket begins with a failing regression test and ends with `pnpm ci:local` passing.
- Modules tested directly: FeishuLink (fake channel status, fake probe, fake clock), Recovery (ordering, coalescing), Outbox (stage/deliver/redeliver idempotence across restart), Continuations (abandon/continue/stale/restart), liveness watchdog, outcome derivation.
- Prior art: the recording Lark channel adapter, existing backfill/journal tests (to be rewritten), the e2e test-bridge with proxy faults (`ws-freeze`, `blackhole --host`, `slow`, `disconnect`, `eai_again`) and the host-sleep scenario.
- Final E2E (T9) tests ONE scenario — disconnect then recover — with disconnection induced 2–3 ways plus kill -9, in card and markdown modes; each run ends with exactly one reply or notice and a drained queue.

## Known limitations

Recovery does not cover these; each is logged or declared rather than silent. Follow-ups: [T10](link-recovery/tickets/T10-review-followups.md), T11–T16.

- **Outage longer than `lookbackMs`** (default 6 h, F29): messages older than the window are not backfilled. At minimum a `backfill.window-truncated` log line; a one-time per-chat notice is proposed in T10.
- **Thread replies in normal groups**: the chat container returns only thread roots, so an @bot inside a thread reply is not backfilled (`backfill.topic-partial`).
- **First-contact DM**: a DM chat with no prior session is not scanned.
- **Local ledger file deleted or corrupted**: backfill looks back only 6 h, and the processed ledger keeps ids for 12 h. So a message older than the window is never fetched again, and the normal prune cannot cause a second answer. A duplicate is possible only if the local ledger file is deleted or corrupted while the message is still within the 6 h window. That is local data corruption and is documented here as a known limitation.
- ~~Redelivered final reply~~ (F11) is no longer a limitation. A send that timed out but landed is deduped by the uuid (≤ 1 h, verified live) or the `parent_id` read-back (> 1 h); see §4a and T16. A reply the agent already sent via CLI is not redelivered (T10 item 2).
- **CLI answer during an outage** (audit F24): not applicable. In a real network outage the agent's CLI send cannot reach Feishu either, so there is no landed CLI answer for the bridge to duplicate.
- **Notice card resolution is not staged** (F15): if updating the card to 已继续 / 已放弃 fails, the old buttons stay; a later click answers 此继续已失效.
- **Inbound works while REST is blackholed** (F18): an inbound WebSocket event counts as evidence, so the link can flap up and down on each inbound message while sends keep failing. Recovery still converges once REST returns.
- **WebSocket permanently failed** (F23): the link stays down forever and nothing is delivered; the bridge only logs. Exiting on this is deferred (§10).
- **Unstaged sends** (F27): policy rejections, group/forward hints, the CoT degraded notice and command replies are not staged and are lost if sent during an outage.
- **Supersede or /new voids a staged answer** (F26, intended): when a newer turn supersedes, or `/new` resets the scope while a reply is still staged, the staged answer and its continuation are voided and never delivered. This is the current behaviour and is kept: the user has moved on.

## Out of Scope

Everything in the deferred list above; Feishu doc-comment surface; multi-account swaps preserving runs.

## Further Notes

- Evidence: E2E round 3 against the run-reliability branch — A1 (resume semantics), A2 (streamed final patch lost, no notice on unclassified EAI_AGAIN), A3 (blackholed run blocked chat > 17 min). Round 3 also recorded real snapshot rollbacks and multi-minute sleeps, which this design treats as ordinary outages.
- Locked user decisions: ordinary message after interruption = abandoned (已放弃), only button/继续 resumes; idle default 15 min (0 disables), tool-call pause cap 60 min; T9 is one scenario with several disconnection methods.
