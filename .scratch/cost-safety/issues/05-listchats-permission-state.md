# 05: `listChats` permanent 401/403 → permission-needs-action state

**What to build:** when `listChats` fails with a permanent permission error, backfill enters a visible `needs-permission` state that stops automatic rescans, keeps the outage window, re-probes rarely, and runs one normal backfill when permission returns — instead of rescanning every 30 s forever.

**Blocked by:** PR #47 merged

**Priority:** P3 — R3b. Real channel (app loses chat-read permission or tenant scope), but slow (≤ 2 attempts/min after back-off) and no model cost.

**Status:** parked

## Parent

[docs/specs/cost-safety.md](../../../docs/specs/cost-safety.md) — D5, D8; Findings R3b; Notes for implementers (classifier).

## What to build

Today (`99480d2`): `runBackfill` catches any `listChats` error, logs `chats-fetch-failed`, sets `chatsFetchFailed` (`src/bot/backfill.ts:123-130`), and the run ends `incomplete` (`:202-215`). Recovery retries on 1→2→4→8→16→30 s, then every 30 s, with no lifetime. Per-chat 4xx is already isolated (`isNonRetryableChatStatus`); `listChats` is not.

Change:

- Classify the `listChats` error with the existing classifier (`src/bot/feishu-error.ts`): HTTP 401/403, or a permission-type `LarkChannelError` (`permission_denied`) → permanent. 429 / 5xx / 408 / network / timeout / no status → transient (unchanged).
- Permanent: ledger keeps `incompleteFrom`; backfill reports `needs-permission`; recovery does **not** schedule its normal retry for this cause; log `chats-permission-needed` once on entry (`status`, business code; no ids).
- Re-probe: one `listChats` at a low cadence (proposed every 30 min), plus on restart, config reload/credential swap and `/doctor`. Success → leave the state and run exactly one backfill over the preserved window (clamped by lookback). Failure → stay, no extra log spam (debug only).
- `/doctor` self-check shows the state.

## Acceptance criteria

- [ ] Red first: fake channel whose `listChats` always rejects with an `sdk-feishu-errors` 403; advance fake time 10 min → more than 10 `listChats` calls on the merged #47 tree.
- [ ] After: same setup → bounded calls (initial + back-off up to the state entry + re-probes at the proposed cadence), state `needs-permission`, one `chats-permission-needed` log.
- [ ] `incompleteFrom` unchanged while in the state.
- [ ] Permission restored (fake starts succeeding) → next re-probe leaves the state and one backfill runs over the preserved window; a human @ from inside that window is enqueued once.
- [ ] 401 behaves like 403; 429, 500 and a status-less error keep today's back-off (existing tests green).
- [ ] Live inbound messages are still handled while in the state.
- [ ] `/doctor` reports the state.
- [ ] `pnpm ci:local` green; delivery note filled.

## Out of scope

- Per-chat history 403 (already isolated).
- Root-causing a tenant's permission change; changing app scopes.
- Owner DM on entering the state (not decided).

## Blocked by

- PR #47 merged
