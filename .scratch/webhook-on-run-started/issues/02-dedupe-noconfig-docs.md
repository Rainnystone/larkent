# 02: Dedupe LRU + no-config notice + README

**Blocked by:** 01 · **Status:** blocked

## Parent
[Spec](../../../docs/specs/webhook-on-run-started.md) — D5, D7, D8, D9.

## What to build
- In-memory LRU keyed by `run_id` (D3), TTL ≈ 10 min, bounded size; repeat within TTL not sent, after TTL sent again.
- URL unset ⇒ all methods noop + exactly one startup `console.warn` (no secrets).
- `flush(timeoutMs)` bounded await of in-flight; `close()` aborts in-flight.
- Docs: `plugins/webhook-on-run-started/README.md` + a short subsection in `README.md` / `README.zh.md` "Optional telemetry": env vars, payload example with placeholder URL `https://example.invalid/hook`, dedupe by `run_id`; restart re-execution gets a new `run_id` and wakes again — receiver must not create duplicate patrols, no message body sent.

## Acceptance criteria
- [ ] Fake-timer tests: suppress within TTL, resend after TTL, size bound evicts oldest.
- [ ] No-URL test: zero fetch calls, exactly one notice across many events.
- [ ] flush/close tests.
- [ ] No real URL/key anywhere in repo (`git grep` clean); `pnpm ci:local` green; CI green.
