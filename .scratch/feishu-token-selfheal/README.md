# Feishu tenant token self-heal — Spec

Status: implementation authorized (user, 2026-11-24 00:53 CST). Tickets: `issues/01-*.md`, `issues/02-*.md`.

## Problem

On 2026-11-23 from 17:00 CST, all three production bridges on the Linux box (profiles `grok`, `cursor`, `devin`; three different Feishu apps) got HTTP 400 with Feishu code `99991663` (tenant access token invalid) on every OpenAPI call, for hours, until each process was restarted. A restart fixed it immediately, so the app credentials were fine; the processes were holding a token Feishu no longer accepted and never asked for a new one.

Proven (details: docs PR #76 description):
- `@larksuiteoapi/node-sdk` 1.73.3 caches the tenant token in `DefaultCache` and decides expiry with the wall clock (`expire*1000 − 180000`). Nothing evicts it when Feishu rejects it. No singleflight.
- The bridge classifies HTTP 400 as `rejected` (`src/bot/feishu-error.ts`), the link probe treats `rejected` as "reachable", and recovery retries with the same `Client`, so the dead token stays forever.
- `src/bot/cot.ts` `CotClient` keeps a second, hand-written token cache (`fetch` + `Date.now()`) with the same gap: a rejected token is never dropped.

Not proven: why the token went bad. The best-evidenced candidate is the host freeze: the box VM was frozen by the platform for hours and the wall clock jumped backwards afterwards (grok log 16:27:13 → 13:12:01). Treat the trigger as unknown. The fix must not depend on knowing it.

## Environment facts the design must respect
- The box is a Linux container (PID 1 `tini`, no systemd). The platform can freeze the whole VM for hours; wall clock may jump forward or backward on resume. Keep-awake (PR #75) is Windows-only and cannot help here.
- The same code runs on the owner's Windows/macOS hosts; the fix is platform-neutral and lives in the bridge.
- One process may host several profiles (`Supervisor`), each with its own `LarkChannel` and app. Fix state is per channel/app, never global.
- WS endpoint fetch (`WSClient.pullConnectConfig`) authenticates with AppID/AppSecret in the body, not a tenant token; it is not affected.

## Decisions (locked)

D1. **Self-heal.** When a Feishu OpenAPI call made with the bridge's own tenant token fails with a token-invalid code, drop that app's cached tenant token, fetch a new one, and replay the original request **once**.

D2. **Codes.** Exactly `99991663` (token invalid/expired) and `99991661` (missing token; the SDK silently sends a request with no `Authorization` when its token fetch returns nothing). Read the structured numeric code from either a rejected error (`response.data.code`, any HTTP status) or a resolved response body (`code`). Never match message text. Never act on `99991664`, `99991668`, `99991672` or any other code. Do not act when the caller passed its own `Authorization` (user token).

D3. **Where.** New module `src/bot/feishu-token-retry.ts`, installed per `LarkChannel` in `startChannel` (`src/bot/channel.ts`) right after the channel is created and before `startFeishuLink` / the probe / `channel.connect()`. Preferred hook: wrap that channel's `rawClient.request`. First step of ticket 01: read the installed SDK source in `node_modules` and confirm every SDK method the bridge uses (`im.v1.*`, `messageResource.get`, cardkit, `getAppInfo`, `application.application.get`, `vc` via `request`) goes through `client.request`. If any bypasses it, hook that client's own `httpInstance` instead. Record what you found in the delivery note. **Do not patch the SDK.**

D4. **Eviction.** Delete the cache entry the SDK actually uses for this app's tenant token (read the key and cache API from SDK source). **Never** evict with `cache.set(key, value, 0)`: `DefaultCache` treats `expiredTime: 0` as never-expire.

D5. **Concurrency.** Per client: one refresh in flight at a time (singleflight) with a generation counter. Requests that fail with a token code while a refresh is running wait for it. A late failure from an older generation does not evict the newer token; it just replays once with the current token.

D6. **Bounds.** At most one replay per original request. If the refresh fails, or the replay fails with a token code again, throw the original error. After such a failure, skip forced refreshes for 10 s (measured on a monotonic clock) so a dead app secret cannot hammer the auth endpoint.

D7. **Writes.** Replay the identical payload. Feishu rejects at the auth gateway before running the call, so a replay does not duplicate a message. Keep any `uuid` already in the payload. Do not add new idempotency keys.

D8. **When self-heal is exhausted (ticket 02).** A token code that still surfaces is an auth/link failure, not a business rejection: `classify()` returns `'link'` for `99991663` and `99991661`. Consequences that must hold: the link probe reports down (no `lastLiveAt` advance, no endless recovery loop, no `controls.restart`); Outbox keeps the message staged instead of marking it permanently rejected; backfill keeps the window incomplete instead of skipping it. Other 4xx codes stay `'rejected'`.

D9. **`CotClient`.** Same behaviour as D1/D2/D6. Preferred: make `CotClient` call through the channel's `rawClient.request` (like `src/meeting/api.ts`) so the bridge has one token path, provided its 15 s per-call bound (`COT_REQUEST_TIMEOUT_MS`) still holds; otherwise give `CotClient` the same evict/refetch/replay-once logic from `feishu-token-retry.ts`. 5xx and timeouts in `CotClient.create` still are not retried.

D10. **Logs.** `auth.token-refreshed` (info: appId, code, outcome) when a replay succeeds; `auth.token-refresh-failed` (warn) when it does not; throttled `link.auth-unhealthy` (warn) from the probe in ticket 02. Never log a token. Avoid field names matching `/token|secret|authorization/i` so `src/core/logger.ts` redaction does not eat them.

D11. **Review amendments (2026-11-24, from PR #77 review).**
- Streamed responses (`responseType: 'stream'`, e.g. `messageResource.get`): on an HTTP 4xx rejection, read at most 64 KB of the error stream, parse it as JSON, and apply D2 to its `code`. If the body is larger, not JSON, or the read fails, treat it as not a token code and rethrow the original error with the body still readable as text. Never read the body of a successful (2xx) stream. (Reverses the earlier non-goal: a dropped attachment is user-visible.)
- Auth-unhealthy link: once a REST call has surfaced an exhausted token code, inbound WebSocket frames must not take the link up. Only a successful REST call (the probe's `getAppInfo` or any outbound call) clears auth-unhealthy and allows `goUp`. This is what "no endless recovery loop" in D8 means under live traffic.
- `CotClient` deadline: the 15 s bound cancels work, not just the caller's wait. Pass an `AbortSignal` that fires at the deadline into the SDK request; the token-retry wrapper must not replay (and must not start a forced refresh on that request's behalf) once the signal has aborted. A create that times out must never be sent late.

## Non-goals
- Dual-clock / monotonic token cache, clock correction, Linux keep-awake.
- Upstream SDK PR, `lark-cli` user-identity calls, WS endpoint auth, `validateAppCredentials`, `registerApp`, `StatusPusher`.
- Patrol changes (Coder / Keeper already check for `99991663`).

## Testing
- Seam: the real SDK `Client` (via the bridge's channel construction where practical) with a fake HTTP adapter that plays the Feishu auth endpoint and an API endpoint. No real Feishu.
- First red test: a cached token the fake server rejects with `400 / 99991663` → today the call fails; after 01 it does one auth POST, one replay, and succeeds.
- Gate: `pnpm ci:local` (`git diff --check && pnpm test && pnpm typecheck && pnpm build`) on the code branch head. GitHub Actions is unavailable; do not wait for it. Box is a shared 16 GB host: cap vitest workers (e.g. `--maxWorkers=2`) and leave no orphaned workers.

## Done gate
Both tickets done on the code PR, `pnpm ci:local` green on its head, Orchestrator verified, PR marked ready, review findings fixed, **not merged** (owner merges with a normal merge commit).
