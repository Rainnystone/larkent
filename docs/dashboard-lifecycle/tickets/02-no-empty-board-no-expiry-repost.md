# 02 — No tasks, no board; no re-post on expiry

Blocked by: 01. Spec: §1.2, §2, D1, D2.

## What
1. `renderChat()`: zero items ⇒ never post or patch; if a binding exists,
   unpin and clear it silently.
2. `patchOrResend()`: on `200750`/`200740`, do not call `sendReplacement()`;
   mark the binding stale. Post a fresh card only when the refresh was caused
   by a real task change (`onChanged`), not by `onRecovered` / `onFireSettled`.
   Thread the refresh reason through `refresh()` in `src/bot/channel.ts`.

## Acceptance
- [ ] Test: zero items + existing binding → 0 `sendManagedCard`/update calls; binding cleared, pin removed.
- [ ] Test: zero items + no binding + recovered refresh → no card sent.
- [ ] Test: items exist, patch returns 200750 on a recovery refresh → 0 new messages.
- [ ] Test: then a task change refresh → exactly 1 fresh card sent and pinned.
- [ ] Message-deleted handling still works for task-change refreshes; existing board tests green.
