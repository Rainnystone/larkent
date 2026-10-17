# A4: Pinned board with Pause/Delete and status block v1

Spec: [../../automations.md](../../automations.md) §7, ADR-007/008/015

**What to build:** per-bot per-group board card listing this bot's tasks (`id`, content summary, kind, next fire, end, status incl. 已错过) with Pause/Resume and Delete buttons any group member can tap; in-place update; single writer per data root (lock + lease); debounced; on every board update check pins and re-pin if missing; "暂无" and unpin when no tasks; re-send and pin if the card can't be patched. The card carries the visible **status block v1** in the existing note element, rendered from the A0c status file: `{v:1, bot, updatedAt, items:[{id, paused, nextFireAt, lastFireAt, lastStatus, endAt, missed}]}`, UTC ms, `id` = the `/auto` number. `/auto`, `/auto pause|resume|delete <id>` as fallback.

**Blocked by:** A0c, A0d

**Depends on #47:** soft — the board is not a terminal reply and does not need the Outbox; re-rendering the board after a link recovery should use the #47 recovered signal once merged, until then the board refreshes on the next change.

**Status:** ready-for-agent

- [ ] Create / pause / resume / delete updates the same card in place; `paused` and `updatedAt` change in the block.
- [ ] Any member's tap works; a stale tap is harmless.
- [ ] Board removed from pins → next update re-pins it; tasks unaffected.
- [ ] Restart/reconnect does not post a second board.
- [ ] Snapshot: the block parses as JSON with `v = 1` and contains no Feishu ID-shaped strings, no task text, no creator.
