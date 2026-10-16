# T1: FeishuLink plus a single recovery path

**Status:** ready-for-agent

## Goal

Introduce FeishuLink (WS state, tick gaps, proxy-aware authenticated probe while down and while up-but-silent, evidence-only watermark) and Recovery (redeliver → backfill outage window → review runs, coalesced). All backfill/resend triggers collapse into `recovered`; process start and supervisor swap call `recover()`.

## Spec sections

§2 FeishuLink; §3 Recovery; §9 rows: keepalive module, backfill trigger, connected-tick resend, BackfillTrigger/skip-short-gap, ledger `lastLiveAt`/`touchLive`; `minGapMs`

## Files touched

new `src/bot/feishu-link.ts`, new `src/bot/recovery.ts`, delete `src/bot/keepalive.ts`, `src/bot/channel.ts`, `src/bot/backfill.ts`, `src/bot/backfill-ledger.ts`, `src/bot/supervisor.ts`, `CONTEXT.md`, `docs/operations.md`, tests

## Acceptance

- [ ] Failing test first: probe failing 2 min while WS stays `connected` → exactly one `recovered` with `since` ≤ failure start; a message posted in that window is answered once.
- [ ] 5-minute sleep (tick gap) → one scan starting before the sleep; a 20-second reconnect does scan.
- [ ] No resend or backfill happens on connected ticks.
- [ ] e2e `ws-freeze` 2 min and `proxy blackhole --host open.feishu.cn` 90 s each → missed @ answered once.
- [ ] `pnpm ci:local` passes.

## Blocked by

T0
