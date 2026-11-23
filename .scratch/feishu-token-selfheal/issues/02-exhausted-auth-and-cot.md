# 02 — Exhausted token failure is a link failure; CotClient joins the same path

Blocked by: 01.
Spec: `README.md` D8, D9, D10.

## What
- `src/bot/feishu-error.ts` `classify()`: `99991663` / `99991661` → `'link'`; every other 4xx stays `'rejected'`.
- Follow the consequences through `src/bot/feishu-link.ts` (probe), Outbox, and `src/bot/backfill.ts` (`isNonRetryableChatStatus` and callers) so D8 holds. Update existing backfill test fixtures that use a bare 400 to a real business 400 code instead of relying on "any 400 is final".
- `src/bot/cot.ts`: route through the channel's `rawClient.request` if the 15 s bound holds, else reuse the 01 logic (D9).
- Docs: one short entry in `CONTEXT.md` (token self-heal, the two codes, exhausted = link) and a troubleshooting line in `docs/operations.md` for `auth.token-refresh-failed` / `link.auth-unhealthy`.

## Acceptance (each is a test, except the docs item)
1. `classify()` returns `'link'` for both codes (rejected error and resolved body), `'rejected'` for `230002`, `230025`, `200610`, `99991672`.
2. Probe with exhausted `99991663` → reports down, `lastLiveAt` unchanged, recovery not looping, no `controls.restart`; `link.auth-unhealthy` throttled.
3. Outbox with exhausted `99991663` → message stays staged, not permanently rejected.
4. Backfill with exhausted `99991663` → window stays incomplete (`backfill.incomplete`), not skipped.
5. `CotClient`: stale token rejected with `99991663` → refresh + one replay succeeds; 5xx/timeout on `create` not retried; 15 s bound kept.
6. `CONTEXT.md` and `docs/operations.md` updated.
7. `pnpm ci:local` green.
