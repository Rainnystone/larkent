# A4: Pinned board with Pause/Delete and status block v1

Spec: [../../automations.md](../../automations.md) §7, ADR-007/008/015/016/017

**What to build:** per-bot per-group board card listing this bot's tasks (`id`, content summary, task type, next fire, end, status) with Pause/Resume and Delete buttons any group member can tap; in-place update; single writer per data root (lock + lease); debounced; on every board update check pins and re-pin if missing; "暂无" and unpin when no tasks; re-send and pin if the card can't be patched. **Missed items** (ADR-016/017): each 已错过 instant is its own row "已错过 原定 YYYY-MM-DD HH:MM" for 24 h, then drops off the board (the automations log keeps it); a one-shot not caught up shows 已错过 until it expires. The card carries the visible **status block v1**, rendered from the A0c status file: `{v:1, bot, updatedAt, items:[{id, paused, nextFireAt, lastFireAt, lastStatus, endAt, missed}]}`, UTC ms, `id` = the `/auto` number. `/auto`, `/auto pause|resume|delete <id>` as fallback.

**Code anchors (master@d056198):**
- "Note" here means the existing markdown element with `text_size: 'notation'` (`noteMd`, src/card/run-renderer.ts:182-184), not a separate note tag.
- Button signing: notice-style tokens are one-time (nonce consumed in `NoticeActionAuth.verify`, src/bot/interruption-notice.ts:164-184) with a 24 h TTL (`NOTICE_TTL_MS`, :20; class at :132). A long-lived board therefore needs either a **reusable signed action** (no nonce; board + item + action bound; the effect is idempotent) or **re-signing on every render** plus a refresh before the TTL lapses. Pick one and test a second tap after the first.
- Refresh the board on link recovery: subscribe to `link.onRecovered` (src/bot/feishu-link.ts:35; existing subscription at src/bot/channel.ts:733-736).

**Blocked by:** A0c, A0d

**Status:** ready-for-agent

- [ ] Create / pause / resume / delete updates the same card in place; `paused` and `updatedAt` change in the block.
- [ ] Any member's tap works; a second tap on the same card still works or says it is stale; a forged tap is harmless.
- [ ] Board removed from pins → next update re-pins it; tasks unaffected.
- [ ] Restart/reconnect does not post a second board; link recovery re-renders it.
- [ ] Missed instants appear as separate 已错过 rows with their original times and drop off after 24 h.
- [ ] Snapshot: the block parses as JSON with `v = 1` and contains no Feishu ID-shaped strings, no task text, no creator.
