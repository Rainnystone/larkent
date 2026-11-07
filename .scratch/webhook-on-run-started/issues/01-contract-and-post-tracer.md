# 01: Contract test + POST tracer

**Blocked by:** None · **Status:** ready-for-agent

## Parent
[Spec](../../../docs/specs/webhook-on-run-started.md) — D1, D2, D3, D4, D5, D6, D9, D10; Known constraint.

## What to build
1. **Contract test** (`tests/unit/core/` or `tests/contract/`): install a capturing adapter, run `log.info('run','started', {...})` inside `withTrace({chatId, msgId})` with realistic ids; assert telemetry receives `phase:'run'`, `event:'started'`, field `runId` **untruncated (strictly equal to the input UUID)**, fields `agent`, `scope`, ctx `chatId`/`msgId` in their sanitized form, and `ts`. Also assert the call site in `src/runtime/run-executor.ts` still emits that name with those fields (drive `RunExecutor` with a fake agent if a seam exists; otherwise a focused test on the fields object).
2. **Plugin** `plugins/webhook-on-run-started/` (ESM, default export `AdapterFactory`, no new deps): on `run`/`started` build the D2 payload with `key = run_id` (D3; truncated chat/thread/message ids are auxiliary only), POST JSON with D4 headers, `AbortSignal.timeout` (D5 default 4000), fire-and-forget, try/catch, warn-only, no secrets in logs. URL unset ⇒ noop (the one-time notice lands in 02).
3. **Unit tests** with mocked `fetch`: only run/started sends; payload shape; both headers (and none when no key); timeout ⇒ warn, no throw, `emit` returns before fetch settles; HTTP 500 / network error ⇒ warn only; console output contains neither URL nor key.

Do **not** change `src/core/logger.ts` sanitization or add a new hook API.

## Acceptance criteria
- [ ] Red then green for contract and unit tests.
- [ ] Contract test fails if `runId` is redacted/truncated by sanitization.
- [ ] Payload `key` equals full `run_id`.
- [ ] Setting `LARK_CHANNEL_TELEMETRY_MODULE` to the plugin + a test URL produces exactly one POST per run/started event.
- [ ] Failure paths never throw and never delay `emit`.
- [ ] `pnpm ci:local` green; CI green on the code PR head.
