# Spec: webhook-on-run-started plugin

## Problem Statement

An operator running several bridge bots wants a supervising agent (a "keeper") to learn, once and directly, that a bot has **started** working on a message, so the keeper can follow up on its own terms. Today nothing outside the bridge learns this: `run`/`started` is only written to the local log (`src/runtime/run-executor.ts`, `log.info('run', 'started', …)` ≈ line 219). Example: a user sends a task in a Feishu group at 10:00; the bot starts a run; the keeper never hears about it unless it polls logs.

## Solution

Ship a generic, opt-in plugin under `plugins/webhook-on-run-started/` that is loaded through the **existing** optional telemetry adapter (`src/core/telemetry.ts`, env `LARK_CHANNEL_TELEMETRY_MODULE`). Its `AdapterFactory(meta)` returns a `TelemetryAdapter` whose `emit` reacts only to `phase === 'run' && event === 'started'` and fires one HTTP POST to an operator-configured webhook. No bridge core behaviour changes; with the env unset the bridge stays a noop.

## Decisions (locked)

- **D1 Hook** — consume the sanitized `run`/`started` telemetry event. No new lifecycle API in v1. A **contract test** in larkent CI locks the event name and the required fields as seen by telemetry (after external sanitization).
- **D2 Payload** — versioned JSON, no message body / prompt text:
  `{ v: 1, type: "run.started", key, bot, scope, chat_id, thread_id, message_id, run_id, agent, ts }`.
  `bot` = configured bot name, falling back to `meta.appId`; `ts` = event `ts`. Missing optional ids are `null`, never omitted.
- **D3 Key** — `key = run_id` (the full `runId`, created by `randomUUID()` in `src/runtime/run-executor.ts` ≈97). It is the dedupe and correlation key. The truncated `chat_id` / `thread_id` / `message_id` are auxiliary context only and never part of the key. A message re-executed after a bridge restart gets a **new** `run_id` and therefore causes another wake — accepted by design; the receiver must not create duplicate patrols for the same task.
- **D4 Auth** — when a key is configured, send it as **both** `Authorization: Bearer <key>` and `X-Automation-Key: <key>` (same convention as larkent-monitor `src/wake.ts`).
- **D5 Config** — env only, filled in by the operator; nothing real in the repo, docs, tests or fixtures (use `https://example.invalid/...` and dummy keys):
  - `LARK_RUN_STARTED_WEBHOOK_URL` (required to activate)
  - `LARK_RUN_STARTED_WEBHOOK_KEY` (optional)
  - `LARK_RUN_STARTED_WEBHOOK_TIMEOUT_MS` (optional, default 4000, clamped 3000–5000)
  - `LARK_RUN_STARTED_BOT_NAME` (optional)
  Final names are the implementer's choice if documented in README; prefix must stay namespaced.
- **D6 Never block, never throw** — `emit` is synchronous and returns immediately; the POST is fire-and-forget (`void promise.catch(...)`), everything wrapped in try/catch, `AbortSignal.timeout(ms)`, **no retry** in v1, failure ⇒ one `console.warn` line with status / error class only. URL query string, key and headers never appear in any log line.
- **D7 Dedupe** — in-memory LRU keyed by `run_id`, TTL ≈ 10 min, bounded size (e.g. 1000). A key seen within TTL is not re-sent. Lost on restart; irrelevant in practice because a restart re-execution has a new `run_id` (see D3).
- **D8 No config** — URL unset ⇒ adapter is a noop for all methods plus exactly **one** startup notice (`console.warn`) saying the plugin is inactive.
- **D9 Other methods** — `recordError` / `recordMetric` noop; `flush(timeoutMs)` awaits in-flight sends bounded by `timeoutMs`; `close()` aborts in-flight sends.
- **D10 Location / packaging** — public repo, generic name, plain ESM module loadable by path via `LARK_CHANNEL_TELEMETRY_MODULE` (default export or `createAdapter`, per `src/core/telemetry.ts`). No new runtime dependency (use global `fetch`).

## Known constraint: id redaction and the correlation key (read before implementing)

Telemetry receives the **externally sanitized** entry: `src/core/logger.ts` `EXTERNAL_SANITIZE` redacts every key in `ID_KEYS` (`chatId`, `msgId`, `messageId`, `threadId`, `sessionId`, …) to `...<last 6 chars>`. So in v1 `chat_id` / `thread_id` / `message_id` are these truncated suffixes and are **auxiliary only** (human hints, never keys).

`runId` is **not** in `ID_KEYS`, so it reaches telemetry in full. It is a random UUID per run (`randomUUID()`, `src/runtime/run-executor.ts` ≈97), and local bridge logs are unredacted, so the receiver can locate the exact task, chat and message by grepping the local log for `run_id`. Hence `key = run_id` (D3) without touching sanitization.

`scope` (from `scopeId`) is not in `ID_KEYS`; the contract test must record what it actually looks like so the payload never carries more than intended. Full ids in the payload remain future work (formal lifecycle hook API).

The contract test asserts that `runId` survives sanitization **untruncated** (equal to the input UUID), that the other required fields (`agent`, `scope`, `ctx.chatId`, `ctx.msgId` when inside `withTrace`, `ts`) arrive in their documented form, and fails if the event is renamed, a field is dropped, or `runId` becomes redacted.

## Testing Decisions

- Seam: the adapter factory, driven with synthetic `TelemetryEvent`s and an injected/mocked `fetch` (vitest). Contract test drives the real `log.info` → `telemetry()` path with a capturing adapter.
- Unit: only `run`/`started` triggers a send; payload shape and `v:1`; both auth headers; timeout aborts and only warns; network/HTTP errors only warn; `emit` never throws and returns before the fetch settles; no URL/key in any captured console output; LRU (keyed by `run_id`) suppresses repeat within TTL and re-sends after TTL (fake timers); no-URL ⇒ zero fetch + exactly one notice.
- Existing suites stay green: `pnpm ci:local` (`git diff --check && pnpm test && pnpm typecheck && pnpm build`).
- Real Feishu E2E (ticket 03) in Bot Arena with the test account and `【端到端测试】` prefix.

## Out of Scope

Monitor changes, Cloudflare/workers, probes, heartbeats, scanners, broadcast to multiple receivers, keeper's follow-up skill, delivery guarantee / retry queue, persisted dedupe, multiple simultaneous telemetry modules, a formal lifecycle hook API, un-redacted ids.

## Future

Formal `onRunStarted` lifecycle hook API (full ids, no log coupling); delivery guarantee; composing several telemetry modules.
