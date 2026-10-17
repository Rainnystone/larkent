# T18: A failing send does not take the link down; recovery has a minimum interval

**Status:** ready-for-agent · Source: 2026-10-17 loop audit of #47 @ `cc6d435`, finding **B3** (related: C2 "no minimum interval between recoveries", spec Known limitation F18)

## Problem (current code, #47 @ `cc6d435`)

A staged item that keeps hitting a `link`-class error (persistent 5xx, the same payload timing out every time, 230020/99991400 that never clears) while Feishu is otherwise reachable produces a loop:

1. `redeliverOwned` → `resendJournalReply` → `channel.send` fails `link` → the wrapped `onResult` in `feishu-link.ts` calls `goDown(lastEvidenceAt)`.
2. The next positive evidence while the WS is connected calls `goUp` → `emitRecovered`. That evidence can be the 15 s tick probe (`getAppInfo`, unwrapped), **any** wrapped REST success (`listChats`, `getChatMode`, `message.list`, …) or any inbound event (`noteInbound`).
3. `recover()` → `recovery.run`: preserve outage (ledger flush), reap, redeliver (fails again → down again), **full backfill** (listChats ≤5 pages + one `message.list` per in-scope chat, ≤50 chats), and `review`.
4. `redeliver` failed, so the run returns `ok=false` → `scheduleRetry` at 1→2→…→30 s (the `458a57f` cooldown holds). The cycle then settles at roughly one full recovery + backfill every 15–30 s, **for as long as the item stays staged**, which is forever (nothing terminalizes `link` failures).
5. Each flap creates a new outage `{since: lastEvidenceAt, until: now}`. `reviewActiveRuns` gives a 2-min stall deadline to every run silent since `since` with no open tool call (`recovery.ts`), replacing the configured idle bound (default 15 min). A run that is merely quiet can be stopped early by an outage that never happened.

This was confirmed by reading the code; the full chain has not been run end to end (the channel closure is large). Steps 1–4 match the audit's mock of `createRecovery` with a persistently failing step.

## Assumptions and how each was checked

Verified:

| # | Assumption | Verdict | Source |
|---|---|---|---|
| V1 | The spec **currently requires** this coupling: §2 "Down on … outbound timeout, no HTTP response, or 5xx", and I5 "Only link errors take the link down" (with 5xx/429 classed `link`). T2 implemented it. | Verified. **This ticket amends spec §2 and I5** (see *Spec change*). | `docs/specs/link-recovery.md` §2 (line ~103), I5; T2 |
| V2 | Feishu signals rate limiting with **HTTP 429** + body `code: 99991400` + `x-ogw-ratelimit-reset` (seconds to wait). Some older APIs use HTTP 400 + 99991400 instead. The docs' guidance is to wait the reset time and retry. | Verified | Feishu doc "频控策略" (`/ukTMukTMukTM/uUzN04SN3QjL1cDN`), fetched 2026-10-17 |
| V3 | IM send limits: 5 QPS to one user; 5 QPS to one group, **shared by all bots in that group**. 230020 "triggers the frequency limit" is HTTP 400. API tier for both `message.create` and `message.list`: 1000/min, 50/s per app. | Verified | create and list docs (request notes, error table, rate-limit row) |
| V4 | Any HTTP response, including 429/5xx, proves the TCP/TLS/HTTP path to the Feishu gateway works. Only "no response" (timeout, errno, axios error with `request` but no `response`) is ambiguous about reachability. | Verified from the error shapes larkent sees: `classify()` already separates `httpStatus()` from `axiosRequestWithoutResponse()`/`networkErrno()`/`OutboundTimeoutError` | `src/bot/feishu-error.ts` |
| V5 | The SDK retries a 5xx 3 times inside one `channel.send` (`inferCode` → `unknown` → retryable; 500 ms, 1500 ms). It does **not** retry 429 differently from `unknown` and does not read `x-ogw-ratelimit-reset`. Axios timeouts (`ECONNABORTED`, larkent `httpTimeoutMs: 30_000`) map to `send_timeout`, which is **not** retried (no `retryTimeouts`). | Verified | `@larksuite/channel` 0.7.1 `dist/index.mjs` `retry` ~L3765, `inferCode` ~L3108; `src/bot/channel.ts` channel options |
| V6 | The probe uses an **unwrapped** `getAppInfo`, so probe results never pass through `onResult`. The probe returns `false` on `link`, `true` on `rejected`, `'unknown'` on `local`, with a 20 s timeout. | Verified | `feishu-link.ts` `createFeishuProbe`, `raceProbe`, `FEISHU_LINK_PROBE_TIMEOUT_MS` |
| V7 | `goUp` fires on any evidence while the WS is connected (probe ok, wrapped REST ok, inbound). Since `19866e2`, inbound does not raise the link while the WS is down. | Verified | `feishu-link.ts` `noteEvidence`, `onResult`; `channel.ts` `link.noteInbound()` |
| V8 | `recovery.run` resets `retryDelayMs` to 1 s after any successful pass and has **no minimum spacing** between successful passes. `queued` and `recovered` now only merge into a pending retry (`458a57f`). | Verified | `src/bot/recovery.ts` `run`, `scheduleRetry` |
| V9 | `reviewActiveRuns` gives the 2-min deadline to silent runs without an open tool call for **every** outage, whatever its evidence. Runs with an open tool call need `hostSuspended`. Each handle is armed only once (`stallArmedAt`). | Verified | `src/bot/recovery.ts` L24–38; `channel.ts` idle watchdog ~L2645–2700 |
| V10 | Feishu's own guidance for internal errors (generic codes 1663/2200/5000) is "retry later / reduce rate". | Verified (text) | Feishu generic server error codes doc |

Still unverified:

| # | Assumption | Status |
|---|---|---|
| U1 | The **HTTP status** Feishu uses for internal errors on send/reply/patch (5xx, or 400 + an internal code). | Unverified. The per-API error tables list only HTTP 400 codes, and the generic table has no HTTP status column. |
| U2 | That a persistent 5xx for **one payload** (while other calls succeed) happens in practice, or how long Feishu-side 5xx episodes last. | Unverified; no production data. |
| U3 | That real agent CLIs (claude/codex stream-json) can be silent > 2 min with no open tool call (for example during long reasoning), which is what makes step 5 a real false kill. | Unverified. Depends on each CLI's event cadence; not measured. |
| U4 | How expensive one full backfill is against Feishu quotas in a real deployment (number of in-scope chats). | Unverified; the bound from config is ≤5 listChats pages + ≤50 `message.list`. |

## Design (from the facts above)

- **Reachability vs. endpoint health are different facts (V4).** A send that got an HTTP response, of any status, proves Feishu is reachable. Recovery (backfill, reap, review) exists for missed inbound and stalled runs **during unreachability**; it cannot fix a 5xx or 429 on one endpoint. So such a failure must not open an outage.
- **"No response" on a send is a suspicion, not proof.** It could be the network, or one slow payload. Let the probe decide: an outbound no-response failure **requests an immediate probe** (single-flight, reusing the tick's probe and timeout). The link goes down only if that probe fails or times out. Blackhole detection stays within the 20 s probe timeout (spec user story 4), and a single bad payload no longer flips the link.
- **Item-level failures get item-level backoff:**
  - 429/99991400/230020: wait `x-ogw-ratelimit-reset` when present (V2), otherwise exponential backoff. Does not consume the item budget (it is our rate, not the item).
  - 5xx and per-item timeouts while the probe says reachable: count toward the same persisted per-item budget as T17. Feishu calls these "retry later" (V10), but U2 is unknown, so the budget keeps a payload that always fails bounded.
- **Recovery gets a minimum interval:** a new recovery pass starts no sooner than `RECOVERY_MIN_INTERVAL_MS` after the previous pass started. Outages that arrive in between are **merged** into the next pass, never dropped, so a back-to-back real outage is still recovered, just later.
- **Run review keys on real outages only.** With the change above, outbound-only failures never create an outage, so they arm no stall deadline.

## Spec change (part of this ticket, needs user sign-off)

- §2 *Down on*: replace "outbound timeout, no HTTP response, or 5xx" with "probe failure or timeout (including a probe requested because an outbound call got no response)". Outbound HTTP responses of any status are reachability evidence.
- I5: "Only link evidence takes the link down: WS not connected, tick gap, failed probe. An outbound error never does by itself; a no-response outbound error triggers a probe."
- §3 Recovery: add the minimum interval and merge rule.
- Known limitation F18 (flapping on inbound while REST is blackholed): bounded by the minimum interval. Update the wording.

## Acceptance (behaviour, failing first)

- [ ] WS connected, probe OK, and every `send` for one staged reply returns HTTP 500 for 10 min (fake clock): **0** `recovered` events, **0** backfill scans, **0** `reapOrphans` calls from recovery, **0** link-down transitions. The item is retried with backoff, and after T17's budget it goes terminal with one `log.fail` (`reason` names the 5xx class).
- [ ] Same with HTTP 429 + `x-ogw-ratelimit-reset: 52`: no retry before 52 s; the item budget is not consumed; no link-down.
- [ ] Same with a send that times out (`OutboundTimeoutError`) while the probe keeps succeeding: exactly one probe is requested per failure (single-flight; not more than one in flight). The link stays up, and there is no recovery or backfill.
- [ ] Sends and the probe both time out (blackhole with WS still connected): the link goes down within one probe timeout (≤ 20 s) of the failed send. When the probe succeeds again, recovery runs once (spec user story 4 still holds).
- [ ] A run silent for 3 min with no open tool call is **not** stopped while the 500/timeout-only scenarios above run. It is stopped only by its configured idle bound.
- [ ] Recovery minimum interval: two real outages 5 s apart → exactly two recovery passes, the second starting no earlier than `RECOVERY_MIN_INTERVAL_MS` after the first; the second outage's window is covered (a message sent during it is answered exactly once). Ten flaps within one interval → at most one extra pass, covering the merged window.
- [ ] The R1 regression (`458a57f`: frozen clock → request count stops growing) still passes.
- [ ] Spec §2, I5, §3 and Known limitation F18 match the implemented behaviour.
- [ ] `pnpm ci:local` passes.

## Needs user approval (not adopted by this ticket)

1. **The spec change above.** It reverses a locked behaviour from T2/I5 ("5xx/timeout takes the link down"). The 2026-10-17 instruction asked for "send failure does not by itself mark the link down", so this is expected to be approved. It is still a spec edit and needs confirmation.
2. **`RECOVERY_MIN_INTERVAL_MS` value.** Proposal: 60 s, which bounds backfill to about 1/min (≤ ~55 requests/min against the 1000/min app quota). Trade-off: messages missed in a second outage that starts within 60 s of a recovery are answered up to 60 s later.
3. **Terminalizing an item after persistent 5xx/timeouts** (via T17's budget) is a lost answer under I1. It needs the same Known-limitation sign-off as T17 item 1.

## Files likely touched

`src/bot/feishu-link.ts` (`onResult`, probe-on-demand), `src/bot/feishu-error.ts` (expose "had HTTP response"; no new class), `src/bot/recovery.ts` (minimum interval + merge), `src/bot/channel.ts` (outbox sweep backoff per item), `src/bot/turn-journal.ts` (budget reuse from T17), link/recovery/outbox tests, `docs/specs/link-recovery.md`

## Blocked by

T17 (per-item persisted attempt budget and terminal reason)
