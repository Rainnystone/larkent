# 04 — Backfill: profile time zone and one bridge delay line

Spec: `docs/specs/confirm-card-reply.md` (Problem row 2, Approach T4).
Blocked by: none.
Code branch: `feat/confirm-card-reply`. Touch `src/bot/backfill.ts`, the backfill wiring in `src/bot/channel.ts` (~1859), and tests.

## Do

1. Red: `formatBackfillLatenessHint` tests with a host `TZ` different from the profile time zone; same-day and previous-day messages.
2. Red: `runBackfill` tests — one fixed delay line per non-empty batch, posted by the bridge before dispatch; none for an empty batch.
3. Green: take the profile time zone as input and format with the existing zoned formatter (`formatZonedDateTime`), including the date when not today. Hint text exactly:
   `以下用户消息发于 {当地日期时间}（约 N 分钟前），bot 离线期间未处理；消息中的相对时间按发送时刻理解。bridge 已自行告知延迟，直接回答用户请求。`
4. Green: the bridge posts one fixed delay line per backfill batch.
5. `/code-review`.

## Acceptance

- [ ] Hint uses the profile time zone regardless of host `TZ`; includes the date when not today; no longer says 「说明延迟原因」.
- [ ] Exactly one delay line per non-empty batch; none for an empty batch.
- [ ] Existing backfill tests green. No automations-skill change. CI green on the code PR head.
