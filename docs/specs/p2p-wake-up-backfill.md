# Spec: P2P / DM wake-up backfill

Status: ready-for-agent (docs track). Grill **skipped** 2026-09-21 — root cause confirmed on master (`fa01065`); product decisions locked with operator in 飞书 Bot 管理. Do not reopen locked decisions without the operator.
Extends v1 wake-up @mention backfill (merged PR #24; design in closed docs PR #23 / Spec §19 follow-on “P2P/DM backfill”).

This document is the destination. Tickets under `.scratch/p2p-wake-up-backfill/issues/` are disposable execution slices. Implementers claim tickets from the docs draft PR; they push product code only to a separate feat PR.

---

## Problem Statement

When the host freezes (or the WebSocket is otherwise dead), Feishu does not replay missed events. Group @mentions are already caught up by in-bridge wake-up backfill. **Private messages (p2p / DM) are not:** after a ~14 minute host freeze on 2026-09-21, a user DM 「在？」 to Grok had **zero** intake in bridge logs, while the same wake-up scan listed 6 groups and enqueued 1 group mention. Heartbeat / supervise cannot recover messages already dropped by the OS freeze; only backfill can. The user must resend manually today.

Root cause on master (deliberate v1 non-goal, not a regression):

1. Chat discovery uses `channel.listChats` → Feishu `im.v1.chat.list`, which returns **groups the bot is in**, not DMs (v1 Spec F9 / §19).
2. History items are normalized with **hardcoded** `chat_type: 'group'`.
3. Backfill keeps only `mentionedBot === true`. Live p2p intake does **not** require @ (`canUseDm`; mention gate is group-only). Normal human→bot DMs therefore cannot survive the backfill filter even if a p2p chat id were scanned.

---

## Solution

On the same recovery signals (`connect` / `reconnected` / keepalive `wake-up`), extend backfill so **session-known p2p chats** are scanned with the existing window / ledger / caps / lateness hint, and human DM messages are enqueued through the **unchanged** `intakeMessage` path (parity with live p2p: no @ required; `canUseDm` still applies inside intake). Group / topic backfill behaviour stays as today.

---

## Seams

Prefer existing seams. Do not invent a second self-heal bus.

1. **Backfill scan seam (primary).** `runBackfill` / `scanChat` / `filterHistoryItem` / `normalizeHistoryItem` in the backfill module. Extend chat enumeration; resolve real `chat_type` before normalize; branch the mention filter for p2p vs group.
2. **Intake seam (reuse, do not fork).** Hand to existing `intakeMessage` → access (`canUseDm` / `canUseGroup`) → pending queue → agent batch. Lateness hint via existing backfill marks.
3. **Session catalog as DM discovery source.** Profile `sessions` / catalog entries already key by `chatId` (= p2p scope). Union with `listChats` (groups). Classify with existing `getChatMode` → `'p2p' | 'group' | 'topic'`.
4. **Out of scope seams.** No host poller; no user-OAuth history; no heartbeat redesign; no Feishu permission product change unless a ticket’s spike proves a missing scope (then stop and report).

Ideal count: **one load-bearing seam** (backfill module) + reuse of intake and session store.

---

## User Stories

1. As a Feishu user who DMed the bot during a host freeze, I want that DM caught up after wake-up without resending, so the bot answers the original message once.
2. As a Feishu user in a group, I want @mention backfill to keep working exactly as today, so this change does not regress group self-heal.
3. As a Feishu user in a DM, I want backfill to accept ordinary human messages without requiring an @mention, matching live DM behaviour.
4. As a Feishu user, I want bot-authored and slash-command DMs skipped on backfill, so the bot does not talk to itself or re-run `/…` from history.
5. As a Feishu user, I want duplicate catch-up prevented by the existing message_id ledger, so a late WS delivery plus backfill does not double-answer.
6. As a Feishu user, I want one lateness hint on a backfilled DM turn, the same shape as group backfill.
7. As an operator, I want DM discovery to use chats the profile already knows (session / catalog scopes), so we do not depend on a Feishu “list all DMs” API that v1 said `listChats` does not provide.
8. As an operator, I want first-contact DMs that never had a session before the outage to remain best-effort / out of scope for this Spec, so we do not block shipping on a new discovery API.
9. As an operator, I want the same lookback / minGap / maxChats / maxRawPerChat / maxMentionsPerChat / enabled / dryRun knobs to apply, with `maxMentionsPerChat` meaning “max enqueued human messages per chat” for both group @mentions and p2p messages.
10. As an operator in `personal` mode, I want DM allowlisting (`canUseDm` / `allowedUsers`) enforced on the intake path the same as live, not reinvented in the scanner.
11. As an operator, I want per-chat `message.list` failures on a DM to follow the existing incomplete-scan / `chat-fetch-failed` path, without aborting the whole group pass.
12. As a dual-track implementer, I want a tracer-bullet ticket that proves one known p2p chat end-to-end, then a hardening ticket for docs/parity, claiming from the docs PR and pushing only to the feat PR.

---

## Implementation Decisions

Locked 2026-09-21 with the operator (飞书 Bot 管理). Grill skipped.

**D1 — Discovery = session-known ∪ group listChats.**  
Enumerate: (a) existing `listChats` results (groups, unchanged), plus (b) distinct `chatId` keys from the profile session store / catalog that resolve via `getChatMode` to `'p2p'`. Do not require a new Feishu “list all DMs” API for this Spec. Optional `preferences.backfill.chats` allowlist still filters the combined set when non-empty.

**D2 — First-contact DM during outage is out of scope.**  
If the freeze window’s only traffic is a brand-new DM with no prior session entry, v1 of this Spec does not invent discovery for it. Operator can still resend; a follow-on may add Feishu DM list API if one is confirmed.

**D3 — Real `chat_type` on normalize.**  
Stop hardcoding `chat_type: 'group'`. Resolve `'p2p' | 'group' | 'topic'` (topic may still normalize as group + thread fields as today) before `normalize`, so intake access / mention gates see the truth.

**D4 — p2p filter matches live (no @ required).**  
For `chat_type === 'p2p'`: keep human messages that are not deleted, not bot-self, not slash-command, not ledger-seen. **Do not** require `mentionedBot`.  
For group / topic: keep today’s `mentionedBot === true` rule (ADR-6 unchanged).

**D5 — Caps / window / ledger / triggers unchanged.**  
Same `lookbackMs`, watermark margin, `minGapMs`, `maxChats` (combined list after filter), `maxRawPerChat`, `maxMentionsPerChat` (newest-first enqueue cap per chat), ledger claim/record, coalesce, `enabled` / `dryRun`, triggers `connect` | `reconnected` | `wake-up`. No separate DM-only knobs in this Spec.

**D6 — Intake path unchanged.**  
Backfill only enqueues `NormalizedMessage` into existing intake. `canUseDm` / `canUseGroup`, mention policy for groups, debounce, agent batch, final reply ownership stay where they are. Lateness hint stays the existing backfill-mark → `extraInstructions` mechanism.

**D7 — Ordering.**  
Within a chat, oldest-first among the newest-N survivors (same as v1). Across chats, existing scan order is fine; no global cross-chat priority redesign.

**D8 — Permissions.**  
Assume bot-tenant `im.v1.message.list` with `container_id_type: 'chat'` works for p2p chat ids the bot already participates in (same shape as groups; topic context already uses this API). If a chat returns a permission error, use existing per-chat failure / incomplete-scan behaviour and surface it in logs — do not add user-OAuth.

**D9 — Vocabulary.**  
Prefer “p2p” / “DM” as in codebase (`chatType === 'p2p'`). Log fields may say `chatType: 'p2p'` on `backfill.chat-scanned` / `enqueued`. Renaming `maxMentionsPerChat` is **not** required; document that for p2p it caps enqueued human messages.

**D10 — Docs track hygiene.**  
Update `CONTEXT.md` self-heal glossary to mention p2p session-known discovery. Operator docs (`docs/operations.md` if present) get a short note. No `/config` UI toggle in this Spec.

---

## Testing Decisions

- Test **external behaviour** of backfill: given fake `listChats`, fake session chat ids, fake `getChatMode`, fake `message.list`, assert which messages are enqueued (and with which `chatType`), not private helper names.
- Prior art: `tests/unit/bot/backfill.test.ts`, `tests/integration/bot/feishu-backfill-parity.test.ts`, connect/reconnected integration tests.
- Required cases:
  - Session-known p2p chat + human text in window → enqueued once; second trigger → `skip-processed`.
  - Same history with bot-self / slash command → not enqueued.
  - p2p human text **without** mentions array → still enqueued (contrast group).
  - Group @mention path unchanged (regression).
  - `chat_type` on normalized / intake messages is `'p2p'` for DM scans.
  - `listChats` groups-only + empty sessions → no p2p enqueue (discovery negative).
  - dryRun logs `would-enqueue` without intake.
- Prefer `/tdd` red then green inside `/implement`. `pnpm ci:local` green on the code PR head.

---

## Out of Scope

- Host freeze prevention, heartbeat redesign, supervise changes.
- Feishu permission / app-scope product changes (unless D8 spike fails — then stop and report).
- First-contact DM with no prior session entry (D2).
- Content near-duplicate suppression when the user resends after silence (v1 §19).
- `/config` card toggle for backfill.
- Changing group ADR-6 (`mentionedBot`-only in groups).
- New Cloud Agent / poller / off-box watcher.
- Renaming preference keys.

---

## Further Notes

- Incident: 2026-09-21 ~17:16 Asia/Shanghai; host `gapMs≈829s`; group backfill worked; Grok p2p 「在？」 absent from intake.
- v1 Spec §19 explicitly deferred P2P/DM backfill pending a DM discovery source — this Spec supplies session-known discovery.
- Matt flow: `/implement` embeds `/tdd`; close with in-session `/code-review` (Standards + Spec). No separate reviewer agent unless the operator asks.
- Merge policy: docs PR stays draft / unmerged scaffolding; code PR merges only after human review; Coder deploys after merge.
