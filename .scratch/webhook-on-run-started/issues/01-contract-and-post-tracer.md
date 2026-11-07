# 01: task_key + contract test + POST tracer

**Blocked by:** None · **Status:** ready-for-agent

## Parent
[Spec](../../../docs/specs/webhook-on-run-started.md) — D1–D6, D9, D10; Known constraint (call-site finding).

## What to build
1. **Minimal core change — `taskKey`:** in `src/bot/channel.ts` where IM `observability` is built (≈1724, inside the flush consumer started ≈537), compute `taskKey = sha256(controls.profile + "\n" + fullChatId + "\n" + batch[0].messageId).hex.slice(0,32)` from the **full** ids (before any logging/sanitization). Add optional `taskKey?: string` to `SubmitRunInput.observability` (`src/runtime/run-executor.ts` ≈61) and include `taskKey` in the `run`/`started` dimensions (≈211–224) when present. Confirm `taskKey` is not in `ID_KEYS` (`src/core/logger.ts`). Other observability builders unchanged.
2. **Contract test:** drive the `run`/`started` path (fake agent / `RunExecutor` seam) with a capturing telemetry adapter; assert `phase:'run'`, `event:'started'`, `taskKey` equal to the expected 32-hex hash, `runId` strictly equal to the input UUID (untruncated), plus `agent`, `scope`, `ts`. Fails if renamed, dropped, or redacted.
3. **Plugin** `plugins/webhook-on-run-started/` (ESM default `AdapterFactory`, no new deps): on `run`/`started` POST the D2 payload with `key = task_key` (fallback `run_id` when absent, `task_key: null`), D4 headers, `AbortSignal.timeout`, fire-and-forget, try/catch, warn-only, no secrets in logs.
4. **Unit tests** (mocked `fetch`): only run/started sends; payload shape; both headers; timeout/HTTP 500/network ⇒ warn only, `emit` returns before fetch settles; no URL/key in console output.

Do **not** change sanitization or add a lifecycle hook API.

## Acceptance criteria
- [ ] Red then green.
- [ ] Same chatId + messageId with different `runId`s (retry/restart) ⇒ identical `taskKey` / payload `key`.
- [ ] Same message re-run after a simulated bridge restart (fresh executor/plugin, new `runId`) ⇒ same `taskKey`, so the receiver keeps exactly one patrol.
- [ ] Different profiles (bots), different messages (same chat) or different chats ⇒ different `taskKey` (never merged).
- [ ] Payload carries full `run_id` and `task_key`, which locate the execution and task exactly in the unredacted local log.
- [ ] Contract test fails if `taskKey` or `runId` is truncated/redacted.
- [ ] `pnpm ci:local` green; CI green on the code PR head.
