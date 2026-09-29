# 02: Persistent per-chat failure isolation

**What to build:** classify per-chat backfill errors so a **non-retryable** HTTP 4xx (e.g. `mode-resolve-failed` HTTP 400 on every run) skips that chat for the window with a warn log (`chatId`, `status`) and lets the window complete, instead of pinning `incompleteFrom` forever. Transient errors keep today's incomplete/retry behaviour.

**Blocked by:** 01 (same file, `src/bot/backfill.ts`).

**Status:** blocked

## Parent

[docs/specs/backfill-self-echo.md](../../../docs/specs/backfill-self-echo.md) — D6 (and D3, D7 as constraints); Problem Statement "Amplifier"; Notes for implementers (status source, HTTP 429, which paths).

## What to build

Today (`src/bot/backfill.ts` on master):

- `classifySessionP2pIds` (`:517-541`) catches any `resolveMode` error, increments `unresolved`, warns `mode-resolve-failed` with `chatId`, `err` only (`:533-536`).
- `scanChat` catches history-fetch errors → warn `chat-fetch-failed` (`:298-302`, with `code` from `errorCode`) → `'fetch-failed'` (`:303`).
- `runBackfill` marks the scan incomplete when `fetchFailures > 0 || chatsFetchFailed || classified.unresolved > 0` (`:210-211`). `markScanIncomplete` keeps the earliest anchor (`src/bot/backfill-ledger.ts:124-130`); short-gap skip requires `incompleteFrom === undefined` (`:127`).
- Evidence: profile `grok`, chat `oc_c7b54801575bc53ff5c7f41497b3c294`, HTTP 400 every run; `incompleteFrom` stuck since 2026-09-22 07:16 CST; `lastBackfillEnd` 2026-09-21; an 11 s reconnect triggers a full 6 h rescan.

Change:

- Add a small classifier: read HTTP status from the error (`error.response.status` on node-sdk/axios errors; note `errorCode` returns axios `error.code` like `'ERR_BAD_REQUEST'` first — do not use it for classification).
- Non-retryable = HTTP 4xx (recommended exception: 429 → transient; flagged in Spec). Transient = 5xx, network, timeout, or no determinable status.
- Mode resolution: non-retryable → warn `mode-resolve-failed` with `chatId`, `status`, and do **not** count toward `unresolved`. Transient → unchanged (counts, keeps incomplete).
- History fetch: non-retryable → warn `chat-fetch-failed` with `chatId`, `status`; chat treated as skipped for this window (does not count toward `fetchFailures`). Transient → unchanged.
- If every other chat succeeds, `markScanComplete` runs as normal (`incompleteFrom` cleared, `lastBackfillEnd` = window end).
- Optional: surface a count of skipped non-retryable chats on the `done` / `incomplete` log line.

Tests (`tests/unit/bot/backfill.test.ts`), red first:

- Session chat whose mode lookup rejects with an HTTP-400-shaped error on every run, starting from a stuck `incompleteFrom`: run 1 logs `done`, `incompleteFrom` cleared, `lastBackfillEnd` advanced; warn includes `chatId` + `status: 400`; run 2 with gap < `minGapMs` logs `skip-short-gap`.
- Same with 5xx-shaped error, network-style error, and a plain `Error` (no status): still `incomplete` (existing `keeps the scan incomplete when session p2p mode lookup fails` stays green).
- History fetch 4xx vs 5xx on one chat: 4xx lets the window complete; 5xx keeps incomplete (existing `B8` / p2p fetch-failure tests stay green or are updated only to use a transient error shape).

Do **not**: add retry counters or new persisted ledger fields, change the global `listChats` failure path, investigate the 400 root cause, or touch bridge/supervise/keepalive.

## Acceptance criteria

- [ ] Red then green on the code PR.
- [ ] A chat whose mode resolution returns 400 on every run no longer leaves the window incomplete.
- [ ] Window advances (`incompleteFrom` cleared, `lastBackfillEnd` moves) and the short-gap skip works again on the next run.
- [ ] A 5xx / network (and status-less) failure still marks the scan incomplete.
- [ ] Warn log includes `chatId` and `status`.
- [ ] No new persisted state / retry counters; ledger schema unchanged.
- [ ] Ticket 01 behaviour and tests unchanged.
- [ ] `pnpm ci:local` green on the code PR; delivery note filled; no Spec/scratch on code PR.

## Out of scope

- Why `oc_c7b54801575bc53ff5c7f41497b3c294` returns 400 (operator issue, D7).
- Global `listChats` failure handling; bounded-retry counters; new persisted state (D6).
- Outbound ledger; config flag; bridge/supervise/keepalive; CLI config (D3, D7).

## Blocked by

- [01: Backfill self-echo tracer](01-self-echo-tracer.md)
