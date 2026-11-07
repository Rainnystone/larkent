# 02: Dedupe LRU + no-config notice + README

**Blocked by:** 01 · **Status:** blocked

## Parent
[Spec](../../../docs/specs/webhook-on-run-started.md) — D5, D7, D8, D9.

## What to build
- In-memory LRU keyed by `key` (= `task_key`, fallback `run_id`) (D3, D7), TTL ≈ 10 min, bounded size; repeat within TTL not sent, after TTL sent again.
- URL unset ⇒ all methods noop + exactly one startup `console.warn` (no secrets).
- `flush(timeoutMs)` bounded await of in-flight; `close()` aborts in-flight.
- Docs: `plugins/webhook-on-run-started/README.md` + a short subsection in `README.md` / `README.zh.md` "Optional telemetry": env vars, payload example with placeholder URL `https://example.invalid/hook`, `task_key` = task, `run_id` = execution; dedupe by `task_key`; after restart the same task may wake again with the same `task_key` and a new `run_id` — receiver dedupes on `task_key` and must not create duplicate patrols, no message body sent.

## Acceptance criteria
- [ ] Same `task_key` with a different `run_id` within TTL ⇒ not re-sent.
- [ ] Fake-timer tests: suppress within TTL, resend after TTL, size bound evicts oldest.
- [ ] No-URL test: zero fetch calls, exactly one notice across many events.
- [ ] flush/close tests.
- [ ] No real URL/key anywhere in repo (`git grep` clean); `pnpm ci:local` green; CI green.
