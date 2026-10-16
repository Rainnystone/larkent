# A4: Pinned board with Pause/Delete for anyone

**What to build:** per-bot per-group board card listing tasks (content, kind, next fire, end, status) with Pause/Resume and Delete buttons any group member can tap; in-place update; single writer per data root (lock + lease); on every board update check pins and re-pin if missing; unpin when no tasks. `/auto`, `/auto pause|resume|delete <n>` as fallback.

**Blocked by:** A1

**Status:** ready-for-agent

- [ ] Create/pause/delete updates the same card in place.
- [ ] Any member's tap works; a stale tap is harmless.
- [ ] Board removed from pins → next update re-pins it; tasks unaffected.
- [ ] Restart/reconnect does not post a second board.
