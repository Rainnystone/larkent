# Automations tickets

Spec: [../../automations.md](../../automations.md). Mattpocock-style vertical slices, **one ticket per session**; each starts with a failing test that asserts what the chat (or the status file / block / automations log) shows and ends with `pnpm ci:local` passing. No latency criteria. Tickets are claimed from this docs PR (#44); code lands on `feat/automations-v2` (draft PR #49, from `master@d056198`). The old code PR #45 (`feat/automations`) is closed.

Re-derived 2026-10-17 from the Spec (ADR-013..015: catch-up ≤ 24 h by fire key, monitor wakes after a miss, status block v1; ADR-016..020: trace every 已错过 instant, one-shot expiry after a miss, accepted read-back limit, agent-task catch-up wording, **agent task** rename with flag `automations.agentTasks`) and **`master@d056198`** (link-recovery #47 merged: Outbox, FeishuLink, default idle bound and "no Continuations" are now on master, so no ticket waits on #47). Every file:line anchor in the tickets was checked against `d056198`. Old A1 (tracer) is split into A0b/A0c/A0d/A1'; old A3 (missed, no catch-up) is replaced by A0c.

| Ticket | Title | Blocked by (tickets) | Status |
|---|---|---|---|
| [A0a](A0a-schedule-pure-functions.md) | Schedule pure functions (grammar, floors, next fires, miss rule, catch-up plan incl. each missed instant) | — | ready |
| [A0b](A0b-store-and-flag.md) | Store (never-reused ids, creation fields, started fire keys, drafts), `automations` settings, automations log, CONTEXT glossary + `isBotOwner` | — | ready |
| [A0c](A0c-scheduler-catch-up.md) | Scheduler + fake clock + fire-key idempotency + catch-up ≤ 24 h + missed trace (injected sender / notifier / wake) | A0a, A0b | ready |
| [A0d](A0d-auto-new-confirm-card.md) | `/auto new` + signed confirm card (NoticeActionAuth-style, `auto.*` route) | A0a, A0b | ready |
| [A1'](A1p-delivery-via-outbox.md) | Reminder + missed-notice delivery via Outbox (per-fire journal entry); missed on link down; catch-up on recovery | A0c, A0d | ready |
| [A2](A2-recurring-creation-and-expiry.md) | Recurring creation, scripted end card, expiry | A0d | ready |
| [A4](A4-board-card.md) | Board + Pause/Delete + 已错过 rows + status block v1 (`id`/`paused`/`updatedAt`) | A0c, A0d | ready |
| [A5](A5-monitor-hook.md) | Monitor hook contract + local wake CLI subcommand | A0c, A4 | ready |
| [A6](A6-natural-language-creation.md) | Natural-language creation | A2 | ready |
| [A7](A7-lifecycle-and-observability.md) | Bot removed / chat disbanded (events + not-in-chat class), DM, observability | A4 | ready |
| [A8](A8-agent-task-run.md) | Agent task: own executor path, fresh session, result post, thread follow-up | A1', A2 | ready |
| [A9](A9-agent-safety-whitelist.md) | Agent-task safety: per-run bot-only identity, whitelist, `policy-guard` | A8 | ready |
| [A10](A10-backfill-skip-non-chat-scopes.md) | Backfill skips `auto:`/`meeting:` scopes (F20) | — | ready |
| [A11](A11-e2e-bot-arena.md) | E2E in Bot Arena (controller) | A0a–A10 | ready-for-human |
| [A13](A13-cards-schema2.md) | **Blocker:** automation cards in CardKit schema 2.0; card-create failure visible, no silent draft | — | ready-for-agent |
| [A14](A14-agent-result-body.md) | Agent result post uses the shared final-reply extraction (`finalText`) | — | ready-for-agent |
| [A15](A15-notice-wording-and-trigger-source.md) | Cross-day 原定 labels, accurate `triggerSource`, no 追问 footer on interrupted/policy-guard notices | A14 | ready-for-agent |
| [A17](A17-oneshot-confirm-and-grok-eos.md) | One-shot confirm card omits monthly frequency; Grok control-token-only text counts as empty | — | ready-for-agent |
| [A18](A18-card-button-access.md) | Automation card buttons are not gated by allowedUsers; denied card actions return a toast | — (after #49 merges) | ready-for-agent |
| [A19](A19-status-push-bridge.md) | Board card drops the status block; bridge pushes a signed status digest to larkent-monitor (lands on #49, before merge) | — (endpoint contract in spec §7) | ready-for-agent |
| [A20](A20-board-tap-refresh.md) | Board tap: check card.update response code, toast immediately, refresh after the callback returns; one-shot cards (confirm, 一个月 / 结束) disable their buttons after the first tap or on expiry | A19 | ready-for-agent |
| [A21](A21-board-rebind-after-pin.md) | Board resend: keep the old binding until the replacement is pinned; on pin failure keep old binding and retry next refresh (Codex r7 P2, lands on #49) | A20 | ready-for-agent |
| [A22](A22-oneshot-card-keep-body.md) | One-shot cards keep their original body after settle (tap 是/否, expiry, startup catch-up, losing concurrent tap); only the button row becomes a result line (已确认 #N / 已取消 / 已过期 / 已指定结束时间); amends A20 (d), lands on #49 | A21 | ready-for-agent |
| [A23](A23-oneshot-day-time-grammar.md) | Schedule grammar: 今天/明天/后天 HH:MM, bare HH:MM = next occurrence, recurring `从 <日期> [HH:MM] 起` start date; proposal prompt gets absolute-time examples; rejected proposals log `auto.rejected` (A11 r5, high) | — | ready-for-agent |
| [A24](A24-no-claim-before-confirm.md) | Never claim 已提交/已创建 before the confirm tap: validate the proposal before the reply body is delivered; failure reason in the same reply; bridge appends 「已生成确认卡，点「是」后生效。」 (A11 r5, medium) | A23 | ready-for-agent |
| [A25](A25-board-sequence-retry-in-place.md) | Board 300317: retry in place with a monotonic higher sequence; resend only on 200740/200750/300311/message deleted; `auto.board.patch` success log with sequence (A11 r5, high) | A22 | ready-for-agent |
| [A26](A26-board-settle-old-and-pending-list.md) | After a resend, settle the old board to a button-less note; taps on a non-current board get a board-specific toast; A21 pending unpin ids become a list (no permanent double pin); amends A21 (A11 r5, medium) | A25 | ready-for-agent |
| [A27](A27-confirm-card-fire-count.md) | Confirm card: 「接下来 N 次」 uses the actual count; one-shot shows its single time / 共 1 次; windows ending within 30 days show 共 N 次 (A11 r5, low) | A22 | ready-for-agent |

## Start order on `feat/automations-v2` (PR #49)

- **Now:** A0a, A0b, A10.
- **After A0a + A0b:** A0c, A0d.
- **After A0c + A0d:** A1', A2, A4; then A5 after A4, A7 after A4, A6 after A2.
- **After A1' + A2:** A8 → A9.
- **Last:** A11.
- **From the first A11 run (2026-10-18):** A13 and A14 now (in parallel), A15 after A14; then rerun the A11 scenarios each ticket lists.
- **From the A11 run on `91b9dec`:** [A17](A17-oneshot-confirm-and-grok-eos.md) (one-shot confirm frequency, Grok `<|eos|>` empty result); then rerun the scenarios that ticket lists.

- **From the A11 r5 run (2026-10-18, code `5552726` + A22):** A23 → A24 (both touch the proposal prompt); A25 → A26 (board resend path); A27 after A22. Rerun the scenarios each ticket lists.

- **Status push (user decision 2026-10-18):** [A19](A19-status-push-bridge.md) on #49 before merge; the receiver is a separate track in the larkent-monitor repo; then rerun the A11 monitor scenarios.

Reminders ship after A0a–A1', A2, A4, A5, A7. Agent tasks (`automations.agentTasks`, default off) ship after A8–A9.

Out of this repo: fixing larkent-monitor so misses stop happening is separate follow-up work (spec, Resolved decisions 6).

## Blocking graph

```mermaid
graph LR
  A0a --> A0c
  A0b --> A0c
  A0a --> A0d
  A0b --> A0d
  A0c --> A1p["A1'"]
  A0d --> A1p
  A0d --> A2
  A0c --> A4
  A0d --> A4
  A0c --> A5
  A4 --> A5
  A2 --> A6
  A4 --> A7
  A1p --> A8
  A2 --> A8
  A8 --> A9
  A10
  A1p & A5 & A6 & A7 & A9 & A10 --> A11
  A11 -.finds.-> A13
  A11 -.finds.-> A14
  A14 --> A15
  A11 -.finds.-> A17
  A18
  A19 --> A11
  A19 --> A20
  A11 -.finds.-> A20
  A20 --> A21
  A21 --> A22
  A11 -.finds.-> A23
  A11 -.finds.-> A24
  A11 -.finds.-> A25
  A11 -.finds.-> A26
  A11 -.finds.-> A27
  A23 --> A24
  A22 --> A25
  A25 --> A26
  A22 --> A27
```
