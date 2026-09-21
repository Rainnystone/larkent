# 01: P2P wake-up backfill tracer (discovery + chat_type + filter)

**What to build:** After a recovery signal, the bridge also scans **session-known p2p chats**, pulls history in the existing backfill window, enqueues ordinary human DM messages (no @ required) through the normal intake path with the usual lateness hint, and leaves group @mention backfill behaviour unchanged.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Parent

[docs/specs/p2p-wake-up-backfill.md](../../../docs/specs/p2p-wake-up-backfill.md) — D1–D8; Problem Statement incident 2026-09-21.

## What to build

Today wake-up backfill only sees groups (`listChats`) and only keeps `mentionedBot`. Live DMs need no @. This ticket cuts one vertical path:

- Discover p2p chat ids from the profile session / catalog store; union with existing `listChats` groups; optional `preferences.backfill.chats` allowlist still applies; classify with `getChatMode === 'p2p'`.
- Normalize history with a **real** `chat_type` (stop hardcoding `'group'`).
- For p2p: enqueue human, non-deleted, non-self, non-slash-command, not-yet-in-ledger messages **without** requiring `mentionedBot`. Groups keep the @-only rule.
- Reuse window, ledger, caps, coalesce, dryRun, triggers, and intake (including `canUseDm` inside intake).
- First-contact DM with no session entry stays out of scope (do not block on a Feishu DM-list API).

## Acceptance criteria

- [ ] Given a fake session-known p2p chat id, fake `getChatMode → p2p`, and `message.list` returning one human text with **no** mentions in the window: one recovery trigger enqueues exactly once into intake; normalized / handed message has `chatType === 'p2p'`; a second identical trigger enqueues 0 (`skip-processed` / ledger).
- [ ] Bot-self and slash-command items in that p2p history are not enqueued.
- [ ] A group @mention fixture still enqueues; a group message without `mentionedBot` still drops.
- [ ] With empty sessions and `listChats` returning only groups, no p2p enqueue occurs.
- [ ] dryRun logs `would-enqueue` and does not call intake.
- [ ] Per-chat `message.list` failure on the p2p chat follows existing fetch-failed / incomplete-scan behaviour without inventing user-OAuth.
- [ ] `/implement` with embedded `/tdd` (red then green); in-session `/code-review` (Standards + Spec); push only to the existing code feat branch; `pnpm ci:local` green; no `.scratch/` or Spec files on the code PR.

## Blocked by

- None (can start immediately).
