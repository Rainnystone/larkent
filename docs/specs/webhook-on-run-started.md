# Spec: webhook-on-run-started plugin

## Problem Statement

An operator running several bridge bots wants a supervising agent (a "keeper") to learn, once and directly, that a bot has **started** working on a message, so the keeper can follow up on its own terms. Today nothing outside the bridge learns this: `run`/`started` is only written to the local log (`src/runtime/run-executor.ts`, `log.info('run', 'started', …)` ≈ line 219). Example: a user sends a task in a Feishu group at 10:00; the bot starts a run; the keeper never hears about it unless it polls logs.

## Solution

Ship a generic, opt-in plugin under `plugins/webhook-on-run-started/` that is loaded through the **existing** optional telemetry adapter (`src/core/telemetry.ts`, env `LARK_CHANNEL_TELEMETRY_MODULE`). Its `AdapterFactory(meta)` returns a `TelemetryAdapter` whose `emit` reacts only to `phase === 'run' && event === 'started'` and fires one HTTP POST to an operator-configured webhook. No bridge core behaviour changes; with the env unset the bridge stays a noop.

## Decisions (locked)

- **D1 Hook** — consume the sanitized `run`/`started` telemetry event. No new lifecycle API in v1. A **contract test** in larkent CI locks the event name and the required fields as seen by telemetry (after external sanitization).
- **D2 Payload** — versioned JSON, no message body / prompt text:
  `{ v: 1, type: "run.started", key, task_key, bot, scope, chat_id, thread_id, message_id, run_id, agent, ts }`.
  `bot` = configured bot name, falling back to `meta.appId`; `ts` = event `ts`. Missing optional ids are `null`, never omitted.
- **D3 Task identity** — new log dimension `task_key` on `run`/`started` = first 32 hex chars of `sha256(profile + "\n" + fullChatId + "\n" + sourceMessageId)` (bot = `observability.profile`), computed **before** sanitization from full ids. The field name `taskKey`/`task_key` must not be in `ID_KEYS` (`src/core/logger.ts`), so it reaches telemetry intact. Payload `key = task_key`.
  - `task_key` = the task (stable across retries and bridge restarts; different tasks never share one).
  - `run_id` = one execution (`randomUUID()`, changes on retry/restart); used to locate that execution in the unredacted local log.
  - truncated `chat_id` / `thread_id` / `message_id` = auxiliary hints only.
  - Runs with no source message (automations, comments, meetings, commands) carry no `task_key` in v1; the plugin then uses `key = run_id` and sets `task_key: null`.
  - Repeated wakes for the same task (retry, restart re-execution) are expected; the receiver dedupes on `task_key` and must not create a duplicate patrol.
- **D3a Receiver contract** — the receiver (Keeper) **reuses the existing patrol** for a known `task_key`; a new `task_key` opens a new patrol. When full ids are needed, Keeper greps the local, unredacted bridge log by `run_id` to resolve the full bot/chat/message ids. If that resolution fails, the patrol is marked **pending verification**; Keeper never guesses ids from the truncated last-6 values.
- **D4 Auth** — when a key is configured, send it as **both** `Authorization: Bearer <key>` and `X-Automation-Key: <key>` (same convention as larkent-monitor `src/wake.ts`).
- **D5 Config** — env only, filled in by the operator; nothing real in the repo, docs, tests or fixtures (use `https://example.invalid/...` and dummy keys):
  - `LARK_RUN_STARTED_WEBHOOK_URL` (required to activate)
  - `LARK_RUN_STARTED_WEBHOOK_KEY` (optional)
  - `LARK_RUN_STARTED_WEBHOOK_TIMEOUT_MS` (optional, default 4000, clamped 3000–5000)
  - `LARK_RUN_STARTED_BOT_NAME` (optional)
  Final names are the implementer's choice if documented in README; prefix must stay namespaced.
- **D6 Never block, never throw** — `emit` is synchronous and returns immediately; the POST is fire-and-forget (`void promise.catch(...)`), everything wrapped in try/catch, `AbortSignal.timeout(ms)`, **no retry** in v1, failure ⇒ one `console.warn` line with status / error class only. URL query string, key and headers never appear in any log line.
- **D7 Dedupe** — in-memory LRU keyed by `key` (= `task_key`, or `run_id` fallback), TTL ≈ 10 min, bounded size (e.g. 1000). A key seen within TTL is not re-sent. Lost on restart; a post-restart re-execution re-sends with the same `task_key`, which the receiver dedupes.
- **D8 No config** — URL unset ⇒ adapter is a noop for all methods plus exactly **one** startup notice (`console.warn`) saying the plugin is inactive.
- **D9 Other methods** — `recordError` / `recordMetric` noop; `flush(timeoutMs)` awaits in-flight sends bounded by `timeoutMs`; `close()` aborts in-flight sends.
- **D10 Location / packaging** — public repo, generic name, plain ESM module loadable by path via `LARK_CHANNEL_TELEMETRY_MODULE` (default export or `createAdapter`, per `src/core/telemetry.ts`). No new runtime dependency (use global `fetch`).

## Known constraint: id redaction and task identity (read before implementing)

Telemetry receives the **externally sanitized** entry: `EXTERNAL_SANITIZE` in `src/core/logger.ts` truncates every `ID_KEYS` value (`chatId`, `msgId`, `messageId`, `threadId`, …) to `...<last 6>`. Truncated ids are not unique, so they must never form the key. Hence `task_key` is hashed from the profile plus the **full** ids inside the bridge and logged under a non-`ID_KEYS` name — a minimal core change owned by ticket 01. The hash exposes no raw id; local logs stay unredacted, so `run_id` plus `task_key` locate the task and execution exactly.

**Call-site finding (where full ids exist):** `RunExecutor.submit` (`src/runtime/run-executor.ts`, `run`/`started` ≈219) receives only `SubmitRunInput` — `scopeId`, `observability {profile, agent, source, stage}`, `toolContext` (`AutomationToolContext.chatId`, full) — and **no message id**. The ambient `withTrace` context on the IM path is set at `src/bot/channel.ts` ≈537 with `chatId` only (the flush consumer; per-message `msgId` is set only around intake at ≈618). Full `chatId` and the batch's message ids are available in `src/bot/channel.ts` where `observability` is built (≈1724; `firstMsg`/`batch`, `batchMessageIds: batch.map(msg => msg.messageId)` ≈1736). Therefore ticket 01 computes `taskKey` there (inputs: `controls.profile`, full `chatId`, source message = `batch[0].messageId`, the first message of the flushed batch) and threads it via a new optional `SubmitRunInput.observability.taskKey`; `run-executor.ts` adds it to the `run`/`started` dimensions as `taskKey`. Other `observability` builders (`src/bot/comments.ts`, `src/automations/agent-run.ts`, `src/meeting/orchestrator.ts`, `src/commands/handlers.ts`) leave it unset in v1.

`scope` (from `scopeId`) is not in `ID_KEYS`; the contract test records its actual form so the payload carries no more than intended.

The contract test asserts: `taskKey` arrives intact (32 hex, equal to the expected hash), `runId` arrives untruncated, the other required fields are present, and it fails if the event is renamed, a field dropped, or either key redacted.

## Testing Decisions

- Seam: the adapter factory, driven with synthetic `TelemetryEvent`s and an injected/mocked `fetch` (vitest). Contract test drives the real `log.info` → `telemetry()` path with a capturing adapter.
- Unit: only `run`/`started` triggers a send; payload shape and `v:1`; both auth headers; timeout aborts and only warns; network/HTTP errors only warn; `emit` never throws and returns before the fetch settles; no URL/key in any captured console output; LRU (keyed by `task_key`) suppresses repeat within TTL and re-sends after TTL (fake timers); no-URL ⇒ zero fetch + exactly one notice.
- Existing suites stay green: `pnpm ci:local` (`git diff --check && pnpm test && pnpm typecheck && pnpm build`).
- Real Feishu E2E (ticket 03) in Bot Arena with the test account and `【端到端测试】` prefix.

## Out of Scope

Monitor changes, Cloudflare/workers, probes, heartbeats, scanners, broadcast to multiple receivers, keeper's follow-up skill, delivery guarantee / retry queue, persisted dedupe, multiple simultaneous telemetry modules, a formal lifecycle hook API, un-redacted ids.

## Future

Formal `onRunStarted` lifecycle hook API (full ids, no log coupling); delivery guarantee; composing several telemetry modules.
