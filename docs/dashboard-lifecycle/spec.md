# Spec: automation dashboard (自动化看板) card lifecycle

## 1. Problem

The per-chat automation dashboard ("本群自动化" card, pinned) is rendered by
`Board.renderChat()` in `src/automations/board.ts` from
`automationBoardCard()` in `src/automations/board-card.ts`, and pushed with
`updateCardByCardId()` (`src/card/cardkit-update.ts`, `cardkit.v1.card.update`)
or re-sent with `sendManagedCard()` (`src/card/managed.ts`).
`refresh()` is called from `src/bot/channel.ts` on `onChanged`, `onFireSettled`
and `started.onRecovered`.

Observed on 2026-11-04 on two bridge profiles running the same code:

1. **300307 on every update, retried all day.** From ~08:07 (UTC+8) both
   profiles got Feishu `300307` ("card content empty") on every dashboard
   update and kept retrying (36x and 14x). The payload is not empty, and one
   profile has a live task, so an empty task list is **not** the cause.
   **Root cause: to be reproduced (待复现).**
2. **Spurious re-post on expiry.** After a reconnect, `onRecovered` →
   `refresh()` → `patch()` got `200750` (card entity expired; message ~2 weeks
   old). `patchOrResend()` maps it via `boardResendReason()` to a resend and
   `sendReplacement()` posts a fresh card into the group. Users saw this as a
   spurious "trigger". It also happened in a chat with **zero** tasks, because
   `renderChat()` keeps rendering while a binding exists
   (`if (items.length === 0 && !binding) return;`) and renders the `暂无` card.

## 2. Code facts (as of master `5feca0b8`)

| Where | Fact |
|---|---|
| `board.ts` `renderAll()` | Renders every chat that has items **or** a stored board binding (`store.listBoards()`). |
| `board.ts` `renderChat()` | Zero items + binding → still patches/resends a `暂无` card, then unpins. Feishu-coded errors are recorded in `failedAttempt` keyed by `boardAttemptKey(card)`; the same card content is skipped next time. |
| `board.ts` `failedAttempt` | In-memory only. Any content change (status/next-run text) or process restart re-arms the attempt, so a persistent rejection like 300307 is retried on every refresh — unbounded. |
| `board.ts` `patch()` / `retrySequence()` | One retry only for `300317` (sequence). Other codes rethrow. |
| `board.ts` `patchOrResend()` + `boardResendReason()` | `200740`/`200750`/message-gone → `sendReplacement()` unconditionally. |
| `board-card.ts` `automationBoardCard()` | Zero items → single `md('暂无')` element. |
| `cardkit-update.ts` `updateCardByCardId()` | Sends `{type:'card_json', data: JSON.stringify(card)}`, `sequence`, `uuid: u_<cardId>_<sequence>`. |

## 3. Decisions (locked)

- **D1. No tasks ⇒ no dashboard.** A chat with zero automation items must not
  get a dashboard posted, patched, or kept. If a binding exists and items drop
  to zero, the bridge cleans up (unpin, drop binding) without posting anything.
  `暂无` rendering is no longer used for the pinned board.
- **D2. Expiry does not post.** When tasks exist and patch returns `200750`
  (or `200740`), do **not** post a new card proactively. Mark the binding
  stale; post a fresh card only on the next **real task change** (`onChanged`
  path), not on reconnect (`onRecovered`) or fire-settled refreshes.
- **D3. 300307: reproduce first.** Reproduce on a test environment, find the
  actual cause, fix the payload accordingly. No guessed fixes before a root
  cause is written down with evidence.
- **D4. Rejected update: log once, stop.** A Feishu-coded rejection of a board
  update is logged once per (chat, code) and the board stops retrying until a
  real task change. No unbounded retry loop, across content drift and restarts.

## 4. Non-goals

- Changing task scheduling, card buttons, or action auth (`board-auth.ts`).
- Changing message-deleted resend semantics beyond D2's trigger rule.
- Restarting or patching live bridges; deploy is a separate human step.

## 5. Open / to verify

- 300307 root cause (ticket 01). Candidates to test, **none confirmed**:
  card JSON schema drift in `card2()`, `uuid` reuse across sequences, CardKit
  entity age, a Feishu-side change around 08:07. Simultaneous onset on two
  profiles hints at an external or time-based trigger.
- Whether D4's "stop" state must be persisted in the store to survive restart
  (expected yes; ticket 01 decides with a test).

## 6. Test seam

Unit: `tests/unit/automations/board-update.test.ts`,
`board-card-failure.test.ts`, `board-card-dedup.test.ts` with a fake
`LarkChannel` returning Feishu codes. Integration:
`tests/integration/bot/auto-board-card.test.ts`.
